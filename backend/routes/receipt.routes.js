const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const { dbGet, dbAll, dbTransaction, dbRun } = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const { clean } = require('../utils/sanitize');

const router = express.Router();
router.use(requireAdmin);

const PAYMENT_METHODS = new Set(['transfer', 'cash', 'promptpay']);

// ปีตามเวลาไทย (server อาจเป็น UTC)
function bangkokYear() {
    return new Date(Date.now() + 7 * 3600 * 1000).getUTCFullYear();
}

// GET /api/receipts?bookingId=  - รายการใบเสร็จ (ล่าสุด 300 ใบ) หรือเฉพาะของการจองนั้น
router.get('/', [query('bookingId').optional().isInt()], async (req, res) => {
    const rows = req.query.bookingId
        ? await dbAll('SELECT * FROM receipts WHERE booking_id = ? ORDER BY id DESC', [req.query.bookingId])
        : await dbAll('SELECT * FROM receipts ORDER BY id DESC LIMIT 300');
    res.json(rows);
});

router.get('/:id', [param('id').isInt()], async (req, res) => {
    const r = await dbGet('SELECT * FROM receipts WHERE id = ?', [req.params.id]);
    if (!r) return res.status(404).json({ error: 'ไม่พบใบเสร็จ' });
    res.json(r);
});

// POST /api/receipts - ออกใบเสร็จของการจองที่อนุมัติแล้ว (เก็บ snapshot ชื่อ/โต๊ะ/ยอด ณ ตอนออก)
// เลขที่ใบเสร็จรันต่อเนื่องรายปี (R2026-0001) ออกโดย server ใน transaction และไม่มีการลบ ถ้าผิดให้ void แล้วออกใหม่
router.post(
    '/',
    [
        body('bookingId').isInt(),
        body('paymentMethod').optional().isString(),
        body('note').optional().isString(),
        body('amount').optional({ nullable: true }).isInt({ min: 0, max: 10000000 })
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ error: 'ข้อมูลใบเสร็จไม่ถูกต้อง' });

        try {
            const receipt = await dbTransaction(async (tx) => {
                const b = await tx.get(
                    'SELECT id, booking_code, first_name, last_name, phone, status, total_amount, payment_method FROM bookings WHERE id = ?',
                    [req.body.bookingId]
                );
                if (!b) throw Object.assign(new Error('ไม่พบรายการจองนี้'), { http: 404 });
                if (b.status !== 'approved') throw Object.assign(new Error('ออกใบเสร็จได้เฉพาะการจองที่อนุมัติแล้ว'), { http: 409 });

                const existing = await tx.get("SELECT receipt_no FROM receipts WHERE booking_id = ? AND status = 'issued'", [b.id]);
                if (existing) {
                    throw Object.assign(new Error(`การจองนี้ออกใบเสร็จแล้ว (เลขที่ ${existing.receipt_no}) หากต้องการออกใหม่ให้ยกเลิก (void) ใบเดิมก่อน`), { http: 409, code: 'ALREADY_ISSUED' });
                }

                const tableRows = await tx.all(
                    `SELECT li.table_code FROM booking_tables bt JOIN layout_items li ON li.id = bt.layout_item_id WHERE bt.booking_id = ? ORDER BY bt.id`,
                    [b.id]
                );
                const year = bangkokYear();
                const counter = await tx.get(
                    `INSERT INTO counters (name, value) VALUES (?, 1)
                     ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value`,
                    [`receipt-${year}`]
                );
                const receiptNo = `R${year}-${String(counter.value).padStart(4, '0')}`;

                const amount = req.body.amount !== undefined && req.body.amount !== null ? Number(req.body.amount) : Number(b.total_amount);
                const method = PAYMENT_METHODS.has(req.body.paymentMethod) ? req.body.paymentMethod : b.payment_method;
                const note = req.body.note ? clean(req.body.note).slice(0, 300) : null;

                const ins = await tx.run(
                    `INSERT INTO receipts (receipt_no, booking_id, booking_code, customer_name, phone, tables, amount, payment_method, note, issued_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [receiptNo, b.id, b.booking_code, `${b.first_name} ${b.last_name}`.trim(), b.phone,
                        tableRows.map(t => t.table_code).join(', '), amount, method, note, req.admin.username]
                );
                return tx.get('SELECT * FROM receipts WHERE id = ?', [ins.lastInsertRowid]);
            });
            res.status(201).json(receipt);
        } catch (err) {
            if (err.http) return res.status(err.http).json({ error: err.message, code: err.code });
            console.error(err);
            res.status(500).json({ error: 'ออกใบเสร็จไม่สำเร็จ' });
        }
    }
);

// POST /api/receipts/:id/void - ยกเลิกใบเสร็จ (ต้องระบุเหตุผล) เลขที่เดิมไม่ถูกนำกลับมาใช้
router.post('/:id/void', [param('id').isInt(), body('reason').isString().trim().notEmpty()], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'กรุณาระบุเหตุผลที่ยกเลิกใบเสร็จ' });

    const r = await dbRun(
        `UPDATE receipts SET status = 'void', void_reason = ?, voided_by = ?, voided_at = datetime('now')
         WHERE id = ? AND status = 'issued'`,
        [clean(req.body.reason).slice(0, 200), req.admin.username, req.params.id]
    );
    if (r.changes === 0) return res.status(404).json({ error: 'ไม่พบใบเสร็จ หรือใบเสร็จถูกยกเลิกไปแล้ว' });
    res.json({ message: 'ยกเลิกใบเสร็จเรียบร้อยแล้ว' });
});

module.exports = router;
