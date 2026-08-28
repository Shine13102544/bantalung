const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

// ----- เชื่อมต่อฐานข้อมูล Turso (Cloud) แทนไฟล์ SQLite บนเครื่อง -----
// ต้องตั้งค่า TURSO_DATABASE_URL และ TURSO_AUTH_TOKEN ใน .env (ดูวิธีได้ที่ turso.tech)
if (!process.env.TURSO_DATABASE_URL) {
    throw new Error('ไม่พบ TURSO_DATABASE_URL ใน .env กรุณาตั้งค่าก่อนรันเซิร์ฟเวอร์ (ดูวิธีได้ที่ turso.tech)');
}

const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
});

// ----- Helper functions: ทำให้หน้าตาคล้าย better-sqlite3 เดิม (.get/.all/.run) แต่เป็น async -----
// ทุกจุดที่เคยเขียน db.prepare(sql).get(...args) ให้เปลี่ยนเป็น await dbGet(sql, [...args]) แทน
async function dbGet(sql, params = []) {
    const result = await client.execute({ sql, args: params });
    return result.rows[0] || undefined;
}

async function dbAll(sql, params = []) {
    const result = await client.execute({ sql, args: params });
    return result.rows;
}

async function dbRun(sql, params = []) {
    const result = await client.execute({ sql, args: params });
    return {
        lastInsertRowid: Number(result.lastInsertRowid ?? 0),
        changes: result.rowsAffected
    };
}

// รันหลายคำสั่งแบบ atomic (ทั้งหมดสำเร็จ หรือไม่มีอะไรถูกบันทึกเลย) - ใช้แทน db.transaction() เดิม
// statements: array ของ { sql, args }
async function dbBatch(statements) {
    return client.batch(
        statements.map(s => ({ sql: s.sql, args: s.args || [] })),
        'write'
    );
}

// รัน raw SQL หลายคำสั่งรวด (ใช้ตอนสร้าง schema เท่านั้น ไม่มี parameter)
async function dbExec(sql) {
    // libsql executeMultiple รองรับหลายคำสั่งคั่นด้วย ; ในสตริงเดียว
    await client.executeMultiple(sql);
}

// รัน transaction แบบโต้ตอบได้ (อ่านค่าระหว่างทางแล้วตัดสินใจต่อได้) - ใช้ตอนต้องเช็คก่อนเขียน
// เช่น เช็คว่าโต๊ะว่างไหมก่อนบันทึกการจอง เพื่อกันโต๊ะซ้ำตอนมีคนจองพร้อมกัน
async function dbTransaction(fn) {
    const tx = await client.transaction('write');
    try {
        const txHelpers = {
            get: async (sql, params = []) => {
                const result = await tx.execute({ sql, args: params });
                return result.rows[0] || undefined;
            },
            all: async (sql, params = []) => {
                const result = await tx.execute({ sql, args: params });
                return result.rows;
            },
            run: async (sql, params = []) => {
                const result = await tx.execute({ sql, args: params });
                return { lastInsertRowid: Number(result.lastInsertRowid ?? 0), changes: result.rowsAffected };
            }
        };
        const returnValue = await fn(txHelpers);
        await tx.commit();
        return returnValue;
    } catch (err) {
        await tx.rollback();
        throw err;
    }
}

// ----- ตั้งค่าฐานข้อมูลเริ่มต้น (schema + migration + seed) -----
// เรียกครั้งเดียวตอนสตาร์ทเซิร์ฟเวอร์ (ดูการเรียกใช้ใน server.js)
async function initDatabase() {
    // 1) สร้างตารางทั้งหมด (ใช้ IF NOT EXISTS ทั้งหมด จึงปลอดภัยรันซ้ำได้)
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await dbExec(schema);

    // 2) Migration: เพิ่มคอลัมน์เช็กอินให้ฐานข้อมูลเก่าที่สร้างไว้ก่อนหน้านี้
    const bookingCols = (await dbAll("PRAGMA table_info(bookings)")).map(c => c.name);
    if (!bookingCols.includes('checked_in')) {
        await dbExec("ALTER TABLE bookings ADD COLUMN checked_in INTEGER NOT NULL DEFAULT 0");
    }
    if (!bookingCols.includes('checked_in_at')) {
        await dbExec("ALTER TABLE bookings ADD COLUMN checked_in_at TEXT");
    }

    // 3) Migration: กู้คืนแถวเวที (stage) ถ้าหายไปจากฐานข้อมูล
    const stageCountRow = await dbGet("SELECT COUNT(*) AS c FROM layout_items WHERE kind = 'stage'");
    if (Number(stageCountRow.c) === 0) {
        await dbRun(`
            INSERT INTO layout_items (kind, table_code, zone_type, label, price, pos_left, pos_top, width, height, color, sort_order)
            VALUES ('stage', NULL, NULL, '🎤 เวทีคอนเสิร์ต (STAGE)', NULL, '150px', '15px', '400px', '55px', '#e74c3c', -1)
        `);
    }

    // 4) Seed ผังโต๊ะเริ่มต้น ถ้ายังไม่มีข้อมูลเลย
    const countRow = await dbGet('SELECT COUNT(*) AS c FROM layout_items');
    if (Number(countRow.c) === 0) {
        const seedItems = [
            { kind: 'stage', table_code: null, zone_type: null, label: '🎤 เวทีคอนเสิร์ต (STAGE)', price: null, pos_left: '150px', pos_top: '15px', width: '400px', height: '55px', color: '#e74c3c', sort_order: 0 },
            { kind: 'zone', table_code: null, zone_type: null, label: 'โซน VIP (ติดขอบเวที)', price: null, pos_left: '80px', pos_top: '90px', width: '540px', height: '110px', color: '#f1c40f', sort_order: 1 },
            { kind: 'table', table_code: 'VIP-01', zone_type: 'vip', label: null, price: '2,500฿', pos_left: '110px', pos_top: '120px', width: '85px', height: '55px', color: '#e74c3c', sort_order: 2 },
            { kind: 'table', table_code: 'VIP-02', zone_type: 'vip', label: null, price: '2,500฿', pos_left: '230px', pos_top: '120px', width: '85px', height: '55px', color: '#e74c3c', sort_order: 3 },
            { kind: 'table', table_code: 'VIP-03', zone_type: 'vip', label: null, price: '2,500฿', pos_left: '350px', pos_top: '120px', width: '85px', height: '55px', color: '#e74c3c', sort_order: 4 },
            { kind: 'table', table_code: 'VIP-04', zone_type: 'vip', label: null, price: '2,500฿', pos_left: '470px', pos_top: '120px', width: '85px', height: '55px', color: '#e74c3c', sort_order: 5 },
            { kind: 'zone', table_code: null, zone_type: null, label: 'โซนธรรมดา (Standard)', price: null, pos_left: '40px', pos_top: '230px', width: '620px', height: '110px', color: '#3498db', sort_order: 6 },
            { kind: 'table', table_code: 'A-01', zone_type: 'normal', label: null, price: '1,200฿', pos_left: '70px', pos_top: '260px', width: '85px', height: '55px', color: '#3498db', sort_order: 7 },
            { kind: 'table', table_code: 'A-02', zone_type: 'normal', label: null, price: '1,200฿', pos_left: '190px', pos_top: '260px', width: '85px', height: '55px', color: '#3498db', sort_order: 8 },
            { kind: 'table', table_code: 'A-03', zone_type: 'normal', label: null, price: '1,200฿', pos_left: '310px', pos_top: '260px', width: '85px', height: '55px', color: '#3498db', sort_order: 9 },
            { kind: 'table', table_code: 'A-04', zone_type: 'normal', label: null, price: '1,200฿', pos_left: '430px', pos_top: '260px', width: '85px', height: '55px', color: '#3498db', sort_order: 10 }
        ];
        await dbBatch(seedItems.map(item => ({
            sql: `INSERT INTO layout_items (kind, table_code, zone_type, label, price, pos_left, pos_top, width, height, color, sort_order)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [item.kind, item.table_code, item.zone_type, item.label, item.price, item.pos_left, item.pos_top, item.width, item.height, item.color, item.sort_order]
        })));
    }

    // 5) Seed ค่า settings เริ่มต้น
    const defaultSettings = {
        concert_title: 'บ้านตะลุง Ban Ta-lung - คอนเสิร์ตสด',
        concert_date: '',
        price_vip: '2,500฿',
        price_normal: '1,200฿',
        price_general: '800฿'
    };
    for (const [key, value] of Object.entries(defaultSettings)) {
        const existing = await dbGet('SELECT value FROM settings WHERE key = ?', [key]);
        if (!existing) {
            await dbRun('INSERT INTO settings (key, value) VALUES (?, ?)', [key, value]);
        }
    }

    // 6) ตารางระบบเมนูอาหาร/ติดต่อเรา (เดิมสร้างแยกในไฟล์ content.routes.js ตอนโหลดโมดูล
    //    ย้ายมารวมไว้ตรงนี้เพราะ Turso ต้องรอผลลัพธ์แบบ async ทำตอนโหลดโมดูลเลยไม่ได้)
    await dbExec(`
        CREATE TABLE IF NOT EXISTS menu_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            category TEXT DEFAULT 'food',
            price REAL NOT NULL,
            is_available INTEGER DEFAULT 1,
            image_url TEXT
        );

        CREATE TABLE IF NOT EXISTS site_contact (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            phone TEXT, line_id TEXT, facebook TEXT, open_hours TEXT, address TEXT, google_maps_url TEXT
        );
    `);
    const contactRow = await dbGet('SELECT id FROM site_contact WHERE id = 1');
    if (!contactRow) {
        await dbRun('INSERT INTO site_contact (id) VALUES (1)');
    }
}

module.exports = { client, dbGet, dbAll, dbRun, dbBatch, dbExec, dbTransaction, initDatabase };
