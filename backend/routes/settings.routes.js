const express = require('express');
const { body, validationResult } = require('express-validator');
const { dbAll, dbBatch } = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const { clean } = require('../utils/sanitize');

const router = express.Router();

// 🟢 1. เพิ่ม คีย์ของธนาคาร ใน ALLOWED_KEYS
const ALLOWED_KEYS = new Set([
    'concert_title', 'concert_date', 'price_vip', 'price_normal', 'price_general',
    'bank_name', 'bank_account_no', 'bank_account_name', 'promptpay_id', 'google_sheet_url',
    'poster_config'
]);

// GET /api/settings - สาธารณะ
router.get('/', async (req, res) => {
    const rows = await dbAll('SELECT key, value FROM settings');
    const obj = {};
    rows.forEach(r => { obj[r.key] = r.value; });
    res.json(obj);
});

// 🟢 2. เพิ่ม GET /api/settings/bank (แก้จุดที่ติด Error 404)
router.get('/bank', async (req, res) => {
    const rows = await dbAll("SELECT key, value FROM settings WHERE key LIKE 'bank_%' OR key = 'promptpay_id'");
    const obj = {};
    rows.forEach(r => { obj[r.key] = r.value; });

    // คืนค่ารูปแบบข้อมูลธนาคาร
    res.json({
        bank_name: obj.bank_name || '',
        account_no: obj.bank_account_no || '',
        account_name: obj.bank_account_name || '',
        promptpay_id: obj.promptpay_id || ''
    });
});

// PUT /api/settings - แอดมินเท่านั้น
router.put('/', requireAdmin, [body().custom(v => typeof v === 'object')], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง' });
    }

    const statements = [];
    for (const [key, value] of Object.entries(req.body)) {
        if (!ALLOWED_KEYS.has(key)) continue;

        let safeValue;
        if (key === 'poster_config') {
            // ข้อมูลนี้เป็น JSON ของลิงก์รูปจาก Cloudinary (ที่ระบบสร้างเอง ไม่ใช่ข้อความที่ผู้ใช้พิมพ์)
            // จึงไม่ใช้ clean() ตัดที่ 500 ตัวอักษรแบบข้อความทั่วไป เพราะ JSON ยาวกว่านั้นได้ง่าย
            // แต่ยังตรวจว่าเป็น JSON ที่ถูกต้องก่อนบันทึกเสมอ กันข้อมูลเพี้ยน
            try {
                JSON.parse(String(value));
            } catch {
                return res.status(400).json({ error: 'ข้อมูลโปสเตอร์ไม่ถูกต้อง (poster_config ต้องเป็น JSON)' });
            }
            safeValue = String(value);
        } else {
            safeValue = clean(String(value));
        }

        statements.push({
            sql: `INSERT INTO settings (key, value) VALUES (?, ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            args: [key, safeValue]
        });
    }

    if (statements.length > 0) await dbBatch(statements);

    res.json({ message: 'บันทึกการตั้งค่าเรียบร้อยแล้ว' });
});

module.exports = router;
