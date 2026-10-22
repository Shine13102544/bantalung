const express = require('express');
const { body, validationResult } = require('express-validator');
const { dbGet, dbAll } = require('../db/database');
const { clean } = require('../utils/sanitize');
const { normalizePhone, isValidPhone } = require('../utils/phone');
const { dbRateLimit, hit, peek, reset, hashKey, sendLimited } = require('../utils/dbRateLimit');

const router = express.Router();

const NOT_FOUND_MSG = 'ไม่พบข้อมูลการจอง กรุณาตรวจสอบชื่อ นามสกุล และเบอร์โทรให้ตรงกับที่กรอกตอนจอง หากยังไม่พบ ให้ติดต่อทางร้านพร้อมแจ้งรหัสจอง';

const lookupIpLimiter = dbRateLimit({
    name: 'ticket-ip', windowMs: 15 * 60 * 1000, max: 40,
    message: 'ค้นหาบัตรถี่เกินไป กรุณารอสักครู่แล้วลองใหม่'
});

// ----- เทียบชื่อให้ "ทนต่อความต่างที่ตาเห็นว่าเหมือนกัน" -----
// ปัญหาที่เจอจริงกับชื่อไทย: ตัวอักษรที่หน้าตาเหมือนกันแต่รหัสต่างกัน เช่น สระอำ (ำ) บางคีย์บอร์ดพิมพ์เป็น นิกหิต+สระอา,
// ช่องว่างแบบ non-breaking หรือตัวอักษรล่องหน (zero-width) ที่ติดมาตอนคัดลอก, เ+เ แทน แ, ตัวพิมพ์เล็ก/ใหญ่ของชื่ออังกฤษ
// จึงปรับทั้งสองฝั่ง (ที่เก็บไว้ + ที่ลูกค้าพิมพ์) ให้เป็นรูปมาตรฐานเดียวกันก่อนเทียบ ใน JavaScript (ไม่เทียบใน SQL)
function canonName(input) {
    let t = String(clean(String(input || '')) || '');
    t = t.normalize('NFKC');
    t = t.replace(/[\p{Z}\p{Cc}\p{Cf}]/gu, '');       // ช่องว่างทุกชนิด, อักขระควบคุม, อักขระล่องหน (zero-width)
    t = t.replace(/[.\-_'’`,·]/g, '');                // เครื่องหมายที่คนมักใส่ต่างกัน เช่น น.ส. / O'Brien / Mary-Ann
    t = t.toLowerCase();
    t = t.replace(/เเ/g, 'แ');                         // เ + เ พิมพ์แทน แ

    // ภาษาไทย: สระบน/ล่างกับวรรณยุกต์ พิมพ์สลับลำดับได้โดยหน้าตาเหมือนกัน (เช่น "หนึ่ง" = ห น ึ ่ ง หรือ ห น ่ ึ ง)
    // Unicode ไม่จัดลำดับให้ จึงเรียงเครื่องหมายที่ซ้อนกันให้เป็นลำดับเดียว และตัดตัวที่พิมพ์ซ้ำ
    // สระอำ (ำ) ให้อยู่หลังสุดเสมอ เพราะ "น้ำ" กับ "นำ้" หน้าตาเหมือนกัน
    t = t.replace(/\u0E4D\u0E32/g, '\u0E33');         // NFKC แยก ำ เป็น นิกหิต+สระอา ประกอบกลับเป็นตัวเดียวก่อน
    t = t.replace(/[\u0E31\u0E33-\u0E3A\u0E47-\u0E4E]+/g, (run) =>
        [...new Set(run)].sort((a, b) => thaiMarkRank(a) - thaiMarkRank(b)).join(''));
    return t;
}
function thaiMarkRank(ch) {
    return ch === '\u0E33' ? 0x0E4F : ch.charCodeAt(0);
}

// คำนำหน้าที่คนมักใส่บ้างไม่ใส่บ้าง (ตัดทั้งสองฝั่งเหมือนกัน จึงไม่ทำให้ชื่อที่ต่างกันกลายเป็นตรงกัน)
const NAME_PREFIXES = ['นางสาว', 'นส', 'นาย', 'นาง', 'คุณ', 'ดช', 'ดญ', 'mr', 'mrs', 'ms', 'miss'];
function stripPrefix(canon) {
    for (const p of NAME_PREFIXES) {
        if (canon.startsWith(p) && canon.length > p.length) return canon.slice(p.length);
    }
    return canon;
}

// ชื่อ+นามสกุลที่เก็บไว้ ตรงกับที่ลูกค้าพิมพ์ไหม (ยอมให้ลูกค้าพิมพ์ชื่อเต็มช่องเดียว หรือสลับช่องชื่อ/นามสกุลได้)
function namesMatch(storedFirst, storedLast, inFirst, inLast) {
    const sf = canonName(storedFirst), sl = canonName(storedLast);
    const f = canonName(inFirst), l = canonName(inLast);
    if (!(f + l) || !(sf + sl)) return false;
    if (sf === f && sl === l) return true;
    if (stripPrefix(sf) === stripPrefix(f) && sl === l) return true;
    if (sf + sl === f + l) return true;                                  // แบ่งช่องต่างกัน เช่น ชื่อเต็มอยู่ในช่องชื่อ
    if (stripPrefix(sf) + sl === stripPrefix(f) + l) return true;
    if (sf === l && sl === f) return true;                               // กรอกสลับช่อง
    return false;
}

async function tablesOf(bookingId) {
    const rows = await dbAll(
        `SELECT li.table_code FROM booking_tables bt JOIN layout_items li ON li.id = bt.layout_item_id WHERE bt.booking_id = ? ORDER BY bt.id`,
        [bookingId]
    );
    return rows.map(r => r.table_code);
}

// ข้อมูลที่ลูกค้าเห็นได้ในหน้า "ดูบัตรของฉัน" — เฉพาะรายการที่อนุมัติแล้วเท่านั้นที่ได้รหัสบัตร (ticketToken) สำหรับ QR
async function publicTicket(b) {
    return {
        bookingCode: b.booking_code,
        name: `${b.first_name} ${b.last_name}`.trim(),
        status: b.status,
        tables: await tablesOf(b.id),
        totalAmount: Number(b.total_amount),
        checkedIn: !!b.checked_in,
        checkedInAt: b.checked_in_at || null,
        createdAt: b.created_at,
        ticketToken: b.status === 'approved' ? b.ticket_token : null
    };
}

// POST /api/tickets/lookup - ลูกค้ากรอกชื่อ + นามสกุล + เบอร์โทร เพื่อดูบัตรของตัวเอง
// กันการไล่เดา: จำกัดต่อ IP + ล็อกเบอร์นั้นชั่วคราวเมื่อกรอกผิดครบ 5 ครั้ง และตอบข้อความเดียวกันทุกกรณีที่ไม่พบ
router.post(
    '/lookup',
    lookupIpLimiter,
    [
        body('firstName').trim().notEmpty().withMessage('กรุณากรอกชื่อ'),
        body('lastName').trim().notEmpty().withMessage('กรุณากรอกนามสกุล'),
        body('phone').trim().notEmpty().withMessage('กรุณากรอกเบอร์โทร')
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

        const phone = normalizePhone(req.body.phone);
        if (!isValidPhone(phone)) return res.status(400).json({ error: 'รูปแบบเบอร์โทรไม่ถูกต้อง' });

        const failKey = `ticket-fail:${hashKey(phone)}`;
        const failed = await peek(failKey);
        if (failed.count >= 5) {
            return sendLimited(res, failed.resetAt, 'กรอกข้อมูลไม่ตรงหลายครั้งเกินไป กรุณารอ 15 นาทีแล้วลองใหม่ หรือติดต่อทางร้าน');
        }

        // เบอร์ในฐานข้อมูลเก็บหลายรูปแบบ (การจองเก่าอาจมีขีด/เว้นวรรค) จึงดึงมาแล้วเทียบเบอร์ที่แปลงเป็นตัวเลขล้วนใน JS
        const all = await dbAll(
            `SELECT id, booking_code, first_name, last_name, phone, status, checked_in, checked_in_at, ticket_token, total_amount, created_at
             FROM bookings ORDER BY created_at DESC`
        );
        const byPhone = all.filter(b => normalizePhone(b.phone) === phone);
        const matches = byPhone.filter(b => namesMatch(b.first_name, b.last_name, req.body.firstName, req.body.lastName));

        if (matches.length === 0) {
            // บันทึกสาเหตุลง log (ไม่มีชื่อ/เบอร์) ไว้ให้แอดมินดูใน Vercel → Logs ว่า "เบอร์ไม่เจอ" หรือ "เบอร์เจอแต่ชื่อไม่ตรง"
            console.warn(byPhone.length
                ? `[ticket-lookup] เบอร์ตรงกับ ${byPhone.length} รายการ (booking id: ${byPhone.map(b => b.id).join(',')}) แต่ชื่อ/นามสกุลไม่ตรง`
                : '[ticket-lookup] ไม่พบเบอร์นี้ในระบบ');
            await hit(failKey, 15 * 60 * 1000);
            return res.status(404).json({ error: NOT_FOUND_MSG });
        }

        await reset(failKey);
        res.json({ bookings: await Promise.all(matches.map(publicTicket)) });
    }
);

const tokenIpLimiter = dbRateLimit({
    name: 'ticket-token-ip', windowMs: 15 * 60 * 1000, max: 60,
    message: 'เรียกดูบัตรถี่เกินไป กรุณารอสักครู่แล้วลองใหม่'
});

// GET /api/tickets/:token - เปิดบัตรจากลิงก์ที่แอดมินส่งให้ (token ยาว 128 บิต เดาไม่ได้)
router.get('/:token', tokenIpLimiter, async (req, res) => {
    const token = String(req.params.token || '').toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(token)) return res.status(404).json({ error: NOT_FOUND_MSG });
    const b = await dbGet(
        `SELECT id, booking_code, first_name, last_name, status, checked_in, checked_in_at, ticket_token, total_amount, created_at
         FROM bookings WHERE ticket_token = ?`,
        [token]
    );
    if (!b) return res.status(404).json({ error: NOT_FOUND_MSG });
    res.json({ bookings: [await publicTicket(b)] });
});

module.exports = router;
