const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const { dbGet } = require('../db/database');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// จำกัดไม่เกิน 8 ครั้ง / 15 นาที ต่อ IP กันคนสุ่มรหัสผ่าน (brute-force)
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'พยายามเข้าสู่ระบบผิดหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่' }
});

router.post(
    '/login',
    loginLimiter,
    [
        body('username').trim().notEmpty().withMessage('กรุณากรอกชื่อผู้ใช้'),
        body('password').notEmpty().withMessage('กรุณากรอกรหัสผ่าน')
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ error: errors.array()[0].msg });
        }

        const { username, password } = req.body;
        const user = await dbGet('SELECT * FROM admin_users WHERE username = ?', [username]);

        // ใช้ error message เดียวกันไม่ว่าจะ user ไม่มีหรือรหัสผิด กัน user enumeration
        if (!user || !bcrypt.compareSync(password, user.password_hash)) {
            return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
        }

        const token = jwt.sign(
            { sub: user.id, username: user.username },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || '4h' }
        );

        res.json({ token, expiresIn: process.env.JWT_EXPIRES_IN || '4h' });
    }
);

// จำกัดไม่เกิน 8 ครั้ง / 15 นาที ต่อ IP เหมือน /login กันคนสุ่มรหัสผ่านผ่าน endpoint นี้เช่นกัน
const verifyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'พยายามยืนยันรหัสผ่านผิดหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่' }
});

// POST /api/auth/verify-password - แอดมินเท่านั้น (ต้อง login/มี JWT อยู่แล้ว):
// ให้พิมพ์รหัสผ่านซ้ำอีกครั้งเพื่อยืนยันตัวตนก่อนทำรายการที่ทำลายข้อมูลถาวร (เช่น "สิ้นสุดคอนเสิร์ต")
// ใช้ req.admin.sub จาก JWT เพื่อเช็คกับรหัสผ่านของบัญชีที่ login อยู่จริงเท่านั้น ป้องกันการสวมรอย
router.post(
    '/verify-password',
    requireAdmin,
    verifyLimiter,
    [body('password').notEmpty().withMessage('กรุณากรอกรหัสผ่าน')],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ error: errors.array()[0].msg });
        }

        const admin = await dbGet('SELECT * FROM admin_users WHERE id = ?', [req.admin.sub]);
        if (!admin || !bcrypt.compareSync(req.body.password, admin.password_hash)) {
            return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
        }

        res.json({ verified: true });
    }
);

module.exports = router;
