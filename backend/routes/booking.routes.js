const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { body, param, validationResult } = require('express-validator');
const { dbGet, dbAll, dbRun, dbTransaction } = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const { clean } = require('../utils/sanitize');
const { makeStorage } = require('../utils/cloudinary');

const router = express.Router();

// ---- ตั้งค่าอัปโหลดสลิป: เก็บขึ้น Cloudinary (ไม่ใช่ดิสก์เครื่อง) จำกัดชนิดไฟล์เป็นรูปภาพเท่านั้น ขนาดไม่เกิน 5MB ----
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const upload = multer({
    storage: makeStorage('slips'),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!ALLOWED_MIME.has(file.mimetype)) {
            return cb(new Error('รองรับเฉพาะไฟล์รูปภาพ (JPEG, PNG, WEBP) เท่านั้น'));
        }
        cb(null, true);
    }
});

function genBookingCode() {
    return 'BK-' + Math.floor(1000 + Math.random() * 9000) + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
}

// POST /api/bookings - ลูกค้าส่งการจองพร้อมสลิป
router.post(
    '/',
    (req, res, next) => {
        upload.single('slip')(req, res, (err) => {
            if (err) return res.status(400).json({ error: err.message });
            next();
        });
    },
    [
        body('firstName').trim().notEmpty().withMessage('กรุณากรอกชื่อ'),
        body('lastName').trim().notEmpty().withMessage('กรุณากรอกนามสกุล'),
        body('phone').trim().matches(/^[0-9\-+() ]{9,15}$/).withMessage('รูปแบบเบอร์โทรไม่ถูกต้อง'),
        body('tableIds').notEmpty().withMessage('กรุณาเลือกโต๊ะอย่างน้อย 1 โต๊ะ')
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ error: errors.array()[0].msg });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'กรุณาแนบสลิปการโอนเงิน' });
        }

        let tableIds;
        try {
            tableIds = JSON.parse(req.body.tableIds);
            if (!Array.isArray(tableIds) || tableIds.length === 0) throw new Error();
        } catch {
            return res.status(400).json({ error: 'รูปแบบรายการโต๊ะไม่ถูกต้อง' });
        }

        const firstName = clean(req.body.firstName);
        const lastName = clean(req.body.lastName);
        const phone = clean(req.body.phone);

        const placeholders = tableIds.map(() => '?').join(',');
        const tables = await dbAll(
            `SELECT id, table_code FROM layout_items WHERE kind = 'table' AND table_code IN (${placeholders})`,
            tableIds
        );

        if (tables.length !== tableIds.length) {
            return res.status(400).json({ error: 'มีโต๊ะบางรายการไม่ถูกต้องหรือถูกลบไปแล้ว' });
        }

        const layoutIds = tables.map(t => t.id);
        const idPlaceholders = layoutIds.map(() => '?').join(',');
        const bookingCode = genBookingCode();

        try {
            await dbTransaction(async (tx) => {
                // เช็คว่าโต๊ะที่เลือกยังว่างอยู่จริงไหม ณ วินาทีนี้ (กันจองซ้ำตอนมีคนกดพร้อมกัน)
                const clashes = await tx.all(`
                    SELECT bt.layout_item_id
                    FROM booking_tables bt
                    JOIN bookings b ON b.id = bt.booking_id
                    WHERE b.status IN ('pending','approved') AND bt.layout_item_id IN (${idPlaceholders})
                `, layoutIds);

                if (clashes.length > 0) {
                    throw new Error('TABLE_TAKEN');
                }

                const result = await tx.run(`
                    INSERT INTO bookings (booking_code, first_name, last_name, phone, slip_filename, status)
                    VALUES (?, ?, ?, ?, ?, 'pending')
                `, [bookingCode, firstName, lastName, phone, req.file.path]);

                for (const id of layoutIds) {
                    await tx.run('INSERT INTO booking_tables (booking_id, layout_item_id) VALUES (?, ?)', [result.lastInsertRowid, id]);
                }
            });
        } catch (err) {
            if (err.message === 'TABLE_TAKEN') {
                return res.status(409).json({ error: 'ขออภัย มีโต๊ะบางรายการเพิ่งถูกจองไปก่อนหน้านี้ กรุณาเลือกโต๊ะใหม่' });
            }
            console.error(err);
            return res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่' });
        }

        res.status(201).json({
            message: 'ส่งข้อมูลการจองเรียบร้อยแล้ว ทางร้านจะรีบดำเนินการตรวจสอบสลิปของท่าน',
            bookingCode
        });
    }
);

// GET /api/bookings/admin - แอดมินเท่านั้น: รายการจองทั้งหมด
router.get('/admin', requireAdmin, async (req, res) => {
    const bookings = await dbAll(`
        SELECT id, booking_code, first_name, last_name, phone, slip_filename, status, checked_in, checked_in_at, created_at
        FROM bookings ORDER BY created_at DESC
    `);

    const result = [];
    for (const b of bookings) {
        const tableRows = await dbAll(`
            SELECT li.table_code FROM booking_tables bt
            JOIN layout_items li ON li.id = bt.layout_item_id
            WHERE bt.booking_id = ?
        `, [b.id]);
        result.push({
            ...b,
            tables: tableRows.map(t => t.table_code).join(', '),
            slipUrl: /^https?:\/\//i.test(b.slip_filename) ? b.slip_filename : `/uploads/${b.slip_filename}`
        });
    }

    res.json(result);
});

// PATCH /api/bookings/admin/:id/status - แอดมินเท่านั้น: อนุมัติ/ปฏิเสธ
router.patch(
    '/admin/:id/status',
    requireAdmin,
    [
        param('id').isInt(),
        body('status').isIn(['approved', 'rejected'])
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ error: errors.array()[0].msg });
        }

        const result = await dbRun(`
            UPDATE bookings SET status = ?, updated_at = datetime('now') WHERE id = ?
        `, [req.body.status, req.params.id]);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'ไม่พบรายการจองนี้' });
        }

        res.json({ message: `อัปเดตสถานะเป็น ${req.body.status} เรียบร้อยแล้ว` });
    }
);

// PATCH /api/bookings/admin/:id/checkin - แอดมินเท่านั้น: ยืนยัน/ยกเลิกการเช็กอินเข้างาน
// ใช้โดยหน้า "ตรวจบัตรเข้าชม" เมื่อคลิกโต๊ะที่มีคนจองไว้แล้ว
router.patch(
    '/admin/:id/checkin',
    requireAdmin,
    [
        param('id').isInt(),
        body('checked_in').isBoolean()
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ error: errors.array()[0].msg });
        }

        const checkedIn = req.body.checked_in ? 1 : 0;
        const result = await dbRun(`
            UPDATE bookings
            SET checked_in = ?, checked_in_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END
            WHERE id = ? AND status = 'approved'
        `, [checkedIn, checkedIn, req.params.id]);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'ไม่พบรายการจองนี้ หรือรายการยังไม่ได้รับการอนุมัติ' });
        }

        res.json({ message: checkedIn ? 'เช็กอินเข้างานเรียบร้อยแล้ว' : 'ยกเลิกการเช็กอินเรียบร้อยแล้ว', checked_in: !!checkedIn });
    }
);

// POST /api/bookings/admin/walkin - บันทึกการจอง Walk-in สำหรับพนักงาน
router.post('/admin/walkin', requireAdmin, async (req, res) => {
    const { firstName, phone, tableCode } = req.body;
    if (!tableCode) return res.status(400).json({ error: 'กรุณาระบุรหัสโต๊ะ' });

    const table = await dbGet("SELECT id FROM layout_items WHERE kind = 'table' AND table_code = ?", [tableCode]);
    if (!table) return res.status(400).json({ error: 'ไม่พบโต๊ะนี้ในระบบ' });

    const bookingCode = 'WALK-' + Math.floor(1000 + Math.random() * 9000);
    const fName = clean(firstName || 'ลูกค้าหน้างาน');
    const pPhone = clean(phone || 'จองผ่านพนักงาน');

    try {
        const bookingId = await dbTransaction(async (tx) => {
            const active = await tx.get(`
                SELECT bt.id FROM booking_tables bt
                JOIN bookings b ON b.id = bt.booking_id
                WHERE b.status IN ('pending','approved') AND bt.layout_item_id = ?
            `, [table.id]);

            if (active) throw new Error('TABLE_TAKEN');

            // ลูกค้าหน้างานซื้อบัตรแล้วเข้างานทันที จึงถือว่าเช็กอินเลยตั้งแต่บันทึก
            const result = await tx.run(`
                INSERT INTO bookings (booking_code, first_name, last_name, phone, slip_filename, status, checked_in, checked_in_at)
                VALUES (?, ?, '(Walk-in)', ?, 'staff_approved', 'approved', 1, datetime('now'))
            `, [bookingCode, fName, pPhone]);

            await tx.run('INSERT INTO booking_tables (booking_id, layout_item_id) VALUES (?, ?)', [result.lastInsertRowid, table.id]);

            return result.lastInsertRowid;
        });

        res.status(201).json({ message: 'บันทึก Walk-in และเช็กอินเรียบร้อย', bookingCode, bookingId, tableCode });
    } catch (err) {
        if (err.message === 'TABLE_TAKEN') {
            return res.status(409).json({ error: 'โต๊ะนี้ถูกจองไปแล้ว' });
        }
        console.error(err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการบันทึกข้อมูล' });
    }
});

// 🟢 POST /api/bookings/end-concert - สิ้นสุดคอนเสิร์ต (ลบรายการจอง + ล้างสถานะเข้างาน โดยรักษาตำแหน่งผังโต๊ะเดิมไว้)
// ใช้ requireAdmin (JWT) เหมือน endpoint แอดมินอื่นๆ ทั้งหมด แทนการรับรหัสผ่านแบบ plaintext ที่ไม่มี rate limit
router.post('/end-concert', requireAdmin, async (req, res) => {
    try {
        // ล้างประวัติการจองทั้งหมด (สถานะเช็กอินอยู่ในตาราง bookings จึงหายไปพร้อมกันโดยอัตโนมัติ)
        // ผังโต๊ะ/พิกัด/สี ใน layout_items ไม่ถูกแตะต้องเลย จึงคงตำแหน่งเดิมไว้ 100%
        await dbTransaction(async (tx) => {
            await tx.run('DELETE FROM booking_tables');
            await tx.run('DELETE FROM bookings');
        });

        res.json({ message: 'สิ้นสุดคอนเสิร์ต เคลียร์สถานะโต๊ะและรายการจองเรียบร้อยแล้ว (คงผังเดิมไว้)' });
    } catch (err) {
        console.error('End concert error:', err);
        res.status(500).json({ error: `Server Error: ${err.message}` });
    }
});

module.exports = router;
