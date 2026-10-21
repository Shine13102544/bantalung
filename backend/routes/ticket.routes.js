const express = require('express');
const { body, validationResult } = require('express-validator');
const { dbGet, dbAll } = require('../db/database');
const { clean } = require('../utils/sanitize');
const { normalizePhone, isValidPhone } = require('../utils/phone');
const { dbRateLimit, hit, peek, reset, hashKey, sendLimited } = require('../utils/dbRateLimit');

const router = express.Router();

const NOT_FOUND_MSG = 'ไม่พบข้อมูลการจอง กรุณาตรวจสอบชื่อ นามสกุล และเบอร์โทรให้ตรงกับที่กรอกตอนจอง';

const lookupIpLimiter = dbRateLimit({
    name: 'ticket-ip', windowMs: 15 * 60 * 1000, max: 40,
    message: 'ค้นหาบัตรถี่เกินไป กรุณารอสักครู่แล้วลองใหม่'
});

function nameKey(s) {
    return String(clean(String(s || '')) || '').toLowerCase().replace(/\s+/g, '');
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

        const fn = nameKey(req.body.firstName);
        const ln = nameKey(req.body.lastName);
        const candidates = await dbAll(
            `SELECT id, booking_code, first_name, last_name, phone, status, checked_in, checked_in_at, ticket_token, total_amount, created_at
             FROM bookings
             WHERE REPLACE(LOWER(first_name), ' ', '') = ? AND REPLACE(LOWER(last_name), ' ', '') = ?
             ORDER BY created_at DESC`,
            [fn, ln]
        );
        const matches = candidates.filter(b => normalizePhone(b.phone) === phone);

        if (matches.length === 0) {
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
