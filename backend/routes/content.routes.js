const express = require('express');
const router = express.Router();
const multer = require('multer');
const { dbGet, dbAll, dbRun } = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const { clean } = require('../utils/sanitize');
const { makeStorage } = require('../utils/cloudinary');

// ---- ตั้งค่า Upload รูปภาพเมนู/โปสเตอร์ ----
// เก็บขึ้น Cloudinary จริง (ไม่ใช่ดิสก์เครื่องเซิร์ฟเวอร์) เพราะ Render/Railway ฯลฯ ไฟล์บนดิสก์จะหาย
// ทุกครั้งที่ redeploy/restart และคนอื่นที่เปิดลิงก์จากเครื่องอื่นจะไม่เห็นรูปเลยถ้าเก็บไว้ในเครื่องเดียว
const menuUpload = multer({ storage: makeStorage('menu') });
const posterUpload = multer({ storage: makeStorage('posters') });

// หมายเหตุ: ตาราง menu_items / site_contact ถูกสร้างรวมไว้ใน db/database.js (initDatabase)
// แล้ว เพราะ Turso ต้องรอผลลัพธ์แบบ async ทำตอนโหลดโมดูลไฟล์นี้เหมือนเดิมไม่ได้

// 🟢 GET /api/content/menu
router.get('/menu', async (req, res) => {
    const items = await dbAll('SELECT * FROM menu_items ORDER BY id DESC');
    res.json(items);
});

// 🟢 POST /api/content/menu/save (อัปโหลดรูปขึ้น Cloudinary โดยตรง)
router.post('/menu/save', requireAdmin, menuUpload.single('image'), async (req, res) => {
    const { id, is_available } = req.body;
    const name = clean(req.body.name || '');
    const category = clean(req.body.category || '');
    const price = Number(req.body.price);
    const imageUrl = req.file ? req.file.path : null; // multer-storage-cloudinary คืน URL เต็มมาใน req.file.path

    if (!name || !Number.isFinite(price) || price < 0) {
        return res.status(400).json({ error: 'กรุณากรอกชื่อเมนูและราคาที่ถูกต้อง' });
    }

    if (id) {
        if (imageUrl) {
            await dbRun('UPDATE menu_items SET name=?, category=?, price=?, is_available=?, image_url=? WHERE id=?',
                [name, category, price, is_available === 'true' ? 1 : 0, imageUrl, id]);
        } else {
            await dbRun('UPDATE menu_items SET name=?, category=?, price=?, is_available=? WHERE id=?',
                [name, category, price, is_available === 'true' ? 1 : 0, id]);
        }
    } else {
        await dbRun('INSERT INTO menu_items (name, category, price, is_available, image_url) VALUES (?, ?, ?, ?, ?)',
            [name, category, price, is_available === 'true' ? 1 : 0, imageUrl]);
    }
    res.json({ message: 'บันทึกเมนูสำเร็จ' });
});

// 🟢 DELETE /api/content/menu/:id
router.delete('/menu/:id', requireAdmin, async (req, res) => {
    await dbRun('DELETE FROM menu_items WHERE id = ?', [req.params.id]);
    res.json({ message: 'ลบสำเร็จ' });
});

// 🟢 GET & POST Contact
router.get('/contact', async (req, res) => {
    res.json(await dbGet('SELECT * FROM site_contact WHERE id = 1'));
});
router.post('/contact/save', requireAdmin, async (req, res) => {
    const phone = clean(req.body.phone || '');
    const line_id = clean(req.body.line_id || '');
    const facebook = clean(req.body.facebook || '');
    const open_hours = clean(req.body.open_hours || '');
    const address = clean(req.body.address || '');
    const google_maps_url = clean(req.body.google_maps_url || '');
    await dbRun('UPDATE site_contact SET phone=?, line_id=?, facebook=?, open_hours=?, address=?, google_maps_url=? WHERE id=1',
        [phone, line_id, facebook, open_hours, address, google_maps_url]);
    res.json({ message: 'อัปเดตเรียบร้อย' });
});

// 🟢 POST /api/content/poster/upload - อัปโหลดรูปโปสเตอร์ 1 รูปขึ้น Cloudinary (แอดมินเท่านั้น)
// คืนแค่ URL กลับไป ไม่ได้บันทึกลง DB ที่นี่ - ฝั่งหน้าเว็บจะเก็บ URL นี้ไว้ในรายการโปสเตอร์
// แล้วค่อยกด "บันทึกโปสเตอร์" (POST /api/settings) เพื่อบันทึกทั้งชุดอีกที
router.post('/poster/upload', requireAdmin, posterUpload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'กรุณาแนบรูปภาพ' });
    res.json({ url: req.file.path });
});

module.exports = router;
