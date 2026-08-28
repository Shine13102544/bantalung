// สคริปต์สำหรับสร้าง/เปลี่ยนรหัสผ่านแอดมิน
// รันด้วยคำสั่ง: npm run seed:admin
// จะถามชื่อผู้ใช้และรหัสผ่าน แล้วเก็บเป็น bcrypt hash ลง DB เท่านั้น (ไม่มี plaintext ในโค้ดเลย)

require('dotenv').config();
const readline = require('readline');
const bcrypt = require('bcryptjs');
const { dbGet, dbRun, initDatabase } = require('./db/database');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

// ซ่อนตัวอักษรรหัสผ่านตอนพิมพ์
function askHidden(query) {
    return new Promise((resolve) => {
        process.stdout.write(query);
        const stdin = process.stdin;
        stdin.resume();
        stdin.setRawMode(true);
        let input = '';
        const onData = (char) => {
            char = char.toString('utf8');
            if (char === '\n' || char === '\r' || char === '\u0004') {
                stdin.setRawMode(false);
                stdin.pause();
                stdin.removeListener('data', onData);
                process.stdout.write('\n');
                resolve(input);
            } else if (char === '\u0003') {
                process.exit(1);
            } else if (char === '\u007f') {
                input = input.slice(0, -1);
            } else {
                input += char;
            }
        };
        stdin.on('data', onData);
    });
}

(async () => {
    console.log('⏳ กำลังเชื่อมต่อฐานข้อมูล Turso...');
    await initDatabase(); // เผื่อรันครั้งแรกสุด ยังไม่เคยมีตาราง admin_users มาก่อน

    const username = (await ask('ชื่อผู้ใช้แอดมิน (default: admin): ')) || 'admin';
    let password = await askHidden('ตั้งรหัสผ่าน (อย่างน้อย 10 ตัวอักษร): ');

    if (password.length < 10) {
        console.error('❌ รหัสผ่านสั้นเกินไป ต้องอย่างน้อย 10 ตัวอักษร');
        process.exit(1);
    }

    const hash = bcrypt.hashSync(password, 12);

    const existing = await dbGet('SELECT id FROM admin_users WHERE username = ?', [username]);
    if (existing) {
        await dbRun('UPDATE admin_users SET password_hash = ? WHERE username = ?', [hash, username]);
        console.log(`✅ อัปเดตรหัสผ่านของผู้ใช้ "${username}" เรียบร้อยแล้ว`);
    } else {
        await dbRun('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)', [username, hash]);
        console.log(`✅ สร้างผู้ใช้แอดมิน "${username}" เรียบร้อยแล้ว`);
    }

    password = null; // เคลียร์ตัวแปรออกจากหน่วยความจำ
    rl.close();
    process.exit(0);
})();
