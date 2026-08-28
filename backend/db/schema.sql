-- ผู้ใช้แอดมิน (รหัสผ่านเก็บเป็น bcrypt hash เท่านั้น ห้ามเก็บ plaintext)
CREATE TABLE IF NOT EXISTS admin_users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ผังงาน: เวที / โซน / โต๊ะ ทั้งหมดอยู่ในตารางเดียว แยกด้วย kind
CREATE TABLE IF NOT EXISTS layout_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL CHECK (kind IN ('stage','zone','table')),
    table_code  TEXT,              -- เช่น 'VIP-01' ใช้เฉพาะ kind='table'
    zone_type   TEXT,              -- 'vip' | 'normal' | 'general' ใช้เฉพาะ kind='table'
    label       TEXT,              -- ข้อความที่แสดง (สำหรับ stage/zone)
    price       TEXT,              -- ราคาที่ snapshot ไว้ ณ เวลาบันทึก เช่น '2,500฿'
    pos_left    TEXT NOT NULL DEFAULT '0px',
    pos_top     TEXT NOT NULL DEFAULT '0px',
    width       TEXT,
    height      TEXT,
    color       TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_layout_table_code
    ON layout_items(table_code) WHERE kind = 'table';

-- การจอง 1 รายการ = 1 ลูกค้า อาจจองได้หลายโต๊ะพร้อมกัน (ดูตาราง booking_tables)
CREATE TABLE IF NOT EXISTS bookings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_code  TEXT UNIQUE NOT NULL,
    first_name    TEXT NOT NULL,
    last_name     TEXT NOT NULL,
    phone         TEXT NOT NULL,
    slip_filename TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    checked_in    INTEGER NOT NULL DEFAULT 0,   -- 1 = ลูกค้าเช็กอินเข้างานแล้ว (หน้าตรวจบัตร)
    checked_in_at TEXT,                          -- เวลาที่เช็กอิน
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ตารางเชื่อม booking <-> โต๊ะ (many-to-many)
CREATE TABLE IF NOT EXISTS booking_tables (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id      INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    layout_item_id  INTEGER NOT NULL REFERENCES layout_items(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_booking_tables_booking ON booking_tables(booking_id);
CREATE INDEX IF NOT EXISTS idx_booking_tables_layout ON booking_tables(layout_item_id);

-- ค่าคอนฟิกทั่วไป (ชื่องาน, วันที่, ราคาแต่ละโซน ฯลฯ) เก็บแบบ key/value
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
