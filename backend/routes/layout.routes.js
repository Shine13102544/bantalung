const express = require('express');
const { body, validationResult } = require('express-validator');
const { dbAll, dbBatch } = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const { clean } = require('../utils/sanitize');

const router = express.Router();

// GET /api/layout - สาธารณะ: หน้าแรกใช้แสดงผังโต๊ะ พร้อมสถานะจองล่าสุด (คำนวณจาก DB จริง ไม่ใช่ localStorage)
router.get('/', async (req, res) => {
    const items = await dbAll('SELECT * FROM layout_items ORDER BY sort_order ASC, id ASC');

    // หาโต๊ะที่กำลังถูกจองอยู่ (pending หรือ approved ถือว่าไม่ว่างแล้ว) พร้อมสถานะเช็กอินจริง (ไม่มีข้อมูลลูกค้าติดมาด้วย)
    const activeRows = await dbAll(`
        SELECT bt.layout_item_id AS id, b.status, b.checked_in
        FROM booking_tables bt
        JOIN bookings b ON b.id = bt.booking_id
        WHERE b.status IN ('pending', 'approved')
    `);
    const statusMap = new Map(activeRows.map(r => [Number(r.id), r.status]));
    const checkedInMap = new Map(activeRows.map(r => [Number(r.id), !!r.checked_in]));

    const result = items.map(item => ({
        ...item,
        booking_status: item.kind === 'table' ? (statusMap.get(Number(item.id)) || 'available') : undefined,
        checked_in: item.kind === 'table' ? (checkedInMap.get(Number(item.id)) || false) : undefined
    }));

    res.json(result);
});

// PUT /api/layout - แอดมินเท่านั้น: บันทึกผังทั้งหมด (ใช้กับตัวแก้ไขแบบลาก-วาง)
// รับ array ของ item ทั้งชุด แล้ว diff กับของเดิม: อัปเดตของเก่า / เพิ่มของใหม่ / ลบที่หายไป
// ห้ามลบโต๊ะที่มีการจองค้างอยู่ (pending/approved) เพื่อไม่ให้ข้อมูลการจองกำพร้า
router.put(
    '/',
    requireAdmin,
    [body('items').isArray({ min: 0 })],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ error: errors.array()[0].msg });
        }

        const items = req.body.items;
        const validKinds = new Set(['stage', 'zone', 'table']);
        for (const it of items) {
            if (!validKinds.has(it.kind)) {
                return res.status(400).json({ error: `kind ไม่ถูกต้อง: ${it.kind}` });
            }
            if (it.kind === 'table' && !it.table_code) {
                return res.status(400).json({ error: 'โต๊ะต้องมีรหัสโต๊ะ (table_code)' });
            }
        }

        const existingRows = await dbAll('SELECT id FROM layout_items');
        const existingIds = new Set(existingRows.map(r => Number(r.id)));
        const incomingIds = new Set(items.filter(i => i.id).map(i => Number(i.id)));
        const toDelete = [...existingIds].filter(id => !incomingIds.has(id));

        // กันลบโต๊ะที่มี booking ค้าง
        if (toDelete.length > 0) {
            const placeholders = toDelete.map(() => '?').join(',');
            const blocked = await dbAll(`
                SELECT DISTINCT bt.layout_item_id
                FROM booking_tables bt
                JOIN bookings b ON b.id = bt.booking_id
                WHERE b.status IN ('pending','approved') AND bt.layout_item_id IN (${placeholders})
            `, toDelete);
            if (blocked.length > 0) {
                return res.status(409).json({ error: 'ไม่สามารถลบโต๊ะที่มีการจองค้างอยู่ได้ กรุณาอนุมัติ/ปฏิเสธการจองก่อน' });
            }
        }

        const statements = [];

        toDelete.forEach(id => {
            statements.push({ sql: 'DELETE FROM layout_items WHERE id = ?', args: [id] });
        });

        items.forEach((it, idx) => {
            const row = {
                kind: it.kind,
                table_code: it.kind === 'table' ? clean(it.table_code) : null,
                zone_type: it.kind === 'table' ? (it.zone_type || 'normal') : null,
                label: it.label ? clean(it.label) : null,
                price: it.price ? clean(it.price) : null,
                pos_left: it.pos_left || '0px',
                pos_top: it.pos_top || '0px',
                width: it.width || null,
                height: it.height || null,
                color: it.color || null,
                sort_order: idx
            };

            if (it.id && existingIds.has(Number(it.id))) {
                statements.push({
                    sql: `UPDATE layout_items SET
                            kind=?, table_code=?, zone_type=?, label=?, price=?,
                            pos_left=?, pos_top=?, width=?, height=?, color=?, sort_order=?
                          WHERE id=?`,
                    args: [row.kind, row.table_code, row.zone_type, row.label, row.price,
                           row.pos_left, row.pos_top, row.width, row.height, row.color, row.sort_order, it.id]
                });
            } else {
                statements.push({
                    sql: `INSERT INTO layout_items (kind, table_code, zone_type, label, price, pos_left, pos_top, width, height, color, sort_order)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    args: [row.kind, row.table_code, row.zone_type, row.label, row.price,
                           row.pos_left, row.pos_top, row.width, row.height, row.color, row.sort_order]
                });
            }
        });

        try {
            if (statements.length > 0) await dbBatch(statements);
        } catch (err) {
            if (String(err.message).includes('UNIQUE')) {
                return res.status(409).json({ error: 'มีรหัสโต๊ะซ้ำกันในผัง กรุณาตรวจสอบ' });
            }
            throw err;
        }

        res.json({ message: 'บันทึกผังเรียบร้อยแล้ว' });
    }
);

module.exports = router;
