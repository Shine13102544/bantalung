// ==========================================================
// admin-tools.js  (โหลดต่อจาก app.js)
// เครื่องมือฝั่งแอดมิน: รีเฟรชแล้วอยู่หน้าเดิม, ปุ่มเปิด/ปิดการขาย/ขายหมด, เงื่อนไขการจอง,
// รายการจอง+ยอดเงินจาก server, ใบเสร็จ, สิ้นสุดคอนเสิร์ตแบบมีสำรองข้อมูล, ส่งออก CSV/Google Sheet
// ==========================================================

// ---------- ตัวช่วยกลาง (ใช้ร่วมกับ inspect.js) ----------
function btEl(id) { return document.getElementById(id); }

function btMoney(n) {
    return (Number(n) || 0).toLocaleString('th-TH');
}

// เวลาใน DB เป็น UTC รูปแบบ 'YYYY-MM-DD HH:MM:SS' (Safari อ่านรูปแบบมีช่องว่างไม่ได้ จึงต้องแปลงเป็น ISO ก่อน)
function btParseDbTime(s) {
    if (!s) return null;
    const d = new Date(String(s).replace(' ', 'T') + 'Z');
    return Number.isNaN(d.getTime()) ? null : d;
}

function btFmtDateTime(s) {
    const d = btParseDbTime(s);
    return d ? d.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'short', timeStyle: 'short' }) : '-';
}

function btFmtTime(s) {
    const d = btParseDbTime(s);
    return d ? d.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' }) : '-';
}

const BT_PAYMENT_LABELS = { transfer: 'โอนเงิน', cash: 'เงินสด', promptpay: 'พร้อมเพย์' };
function btPaymentLabel(m) { return BT_PAYMENT_LABELS[m] || m || '-'; }

// ข้อความแจ้งเตือนสั้นๆ มุมจอ (แทน alert ที่ขัดจังหวะการทำงานหน้างาน)
function btToast(message, type = 'info', ms = 3200) {
    let box = btEl('bt-toast-box');
    if (!box) {
        box = document.createElement('div');
        box.id = 'bt-toast-box';
        document.body.appendChild(box);
    }
    const t = document.createElement('div');
    t.className = `bt-toast ${type}`;
    t.textContent = message;
    box.appendChild(t);
    setTimeout(() => t.remove(), ms);
}

// สร้างหน้าต่าง modal ครั้งเดียวต่อ id (เนื้อหาใส่ผ่าน innerHTML ที่เราเขียนเอง ข้อมูลผู้ใช้ต้องผ่าน escapeHtml เสมอ)
function btModal(id, innerHtml, { wide = false } = {}) {
    let m = btEl(id);
    if (!m) {
        m = document.createElement('div');
        m.id = id;
        m.className = 'bt-modal-backdrop';
        m.innerHTML = `<div class="bt-modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true"></div>`;
        m.addEventListener('mousedown', (e) => { if (e.target === m) btCloseModal(id); });
        document.body.appendChild(m);
    }
    m.firstElementChild.innerHTML = innerHtml;
    return m;
}
function btOpenModal(id) { const m = btEl(id); if (m) m.style.display = 'flex'; }
function btCloseModal(id) { const m = btEl(id); if (m) m.style.display = 'none'; }
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.bt-modal-backdrop').forEach(m => {
        if (m.style.display !== 'none' && m.id !== 'bt-scan-overlay') m.style.display = 'none';
    });
});

// ดาวน์โหลดไฟล์จาก endpoint ที่ต้อง login (แนบ token แล้วแปลงเป็น blob)
async function btDownloadAuthed(path, filename) {
    const res = await apiFetch(path, { headers: { ...authHeaders() } });
    if (!res.ok) {
        let msg = 'ดาวน์โหลดไม่สำเร็จ';
        try { msg = (await res.json()).error || msg; } catch (_) { /* ไม่ใช่ JSON */ }
        throw new Error(msg);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function btJson(path, { method = 'GET', body } = {}) {
    const opts = { method, headers: { ...authHeaders() } };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await apiFetch(path, opts);
    let data = {};
    try { data = await res.json(); } catch (_) { /* ไม่มี body */ }
    return { ok: res.ok, status: res.status, data };
}

// ---------- รีเฟรชแล้วอยู่หน้าแอดมินเดิม + สิทธิ์ ----------
function applyRoleUI() {
    document.body.dataset.role = getToken() ? getRole() : '';
}

// เข้าหน้าแรกของแต่ละสิทธิ์หลัง login: แอดมิน = เมนูหลัก, พนักงานหน้างาน = หน้าตรวจบัตร
function enterAdminByRole() {
    applyRoleUI();
    if (getRole() === 'staff') {
        showAdminHub();            // ซ่อนส่วนฝั่งลูกค้า
        openAdminInspect();
    } else {
        showAdminHub();
        afterAdminEnter();
    }
}

function afterAdminEnter() {
    loadBankSettingsToAdminForm();
    renderBookingRules();
    renderSalesQuick();
}

async function restoreAdminSession() {
    if (!getToken()) { applyRoleUI(); return; }
    let me;
    try {
        const res = await fetch(`${API_BASE}/api/auth/me`, { headers: { ...authHeaders() } });
        if (res.status === 401) { clearToken(); applyRoleUI(); return; }   // token หมดอายุจริง → กลับหน้าแรก
        if (!res.ok) return;
        me = await res.json();
    } catch (_) {
        return; // เน็ตหลุดชั่วคราว: เก็บ token ไว้ ยังไม่เด้งออก
    }
    localStorage.setItem(ROLE_KEY, me.role);
    applyRoleUI();

    let page = sessionStorage.getItem(ADMIN_PAGE_KEY) || (me.role === 'staff' ? 'inspect' : 'hub');
    if (me.role === 'staff') page = 'inspect';

    showAdminHub();                 // ซ่อนส่วนฝั่งลูกค้าก่อนเสมอ
    if (page === 'inspect') openAdminInspect();
    else if (page === 'layout-editor') openLayoutEditor();
    else if (page === 'booking' || page === 'poster') openAdminSubPage(page);
    afterAdminEnter();
}

// ---------- สถานะการขายบัตร: เปิด / ปิดการขาย / ขายหมด ----------
const SALES_LABELS = { open: '🟢 เปิดขายอยู่', closed: '⏸️ ปิดการขาย', soldout: '🚫 ขายหมดแล้ว' };
window.__salesState = { open: true };

async function fetchSalesState() {
    try {
        const res = await fetch(`${API_BASE}/api/settings/sales`, { cache: 'no-store' });
        return res.ok ? await res.json() : { open: true };
    } catch (_) {
        return { open: true };
    }
}

// แสดง/ซ่อนแบนเนอร์ที่หน้าลูกค้า และปิดปุ่มจองเมื่อไม่ได้เปิดขาย (server บังคับซ้ำอีกชั้น)
async function applySalesState() {
    const st = await fetchSalesState();
    window.__salesState = st;

    const ensureBanner = (id, parent, before) => {
        let b = btEl(id);
        if (!b && parent) {
            b = document.createElement('div');
            b.id = id; b.className = 'bt-sales-banner'; b.style.display = 'none';
            parent.insertBefore(b, before || parent.firstChild);
        }
        return b;
    };
    const bookingSec = btEl('booking');
    const banners = [
        ensureBanner('sales-banner', bookingSec, bookingSec && bookingSec.firstChild),
        ensureBanner('sales-banner-home', btEl('table-summary-section'), btEl('table-summary-section') && btEl('table-summary-section').firstChild)
    ];
    banners.forEach(b => {
        if (!b) return;
        b.style.display = st.open ? 'none' : 'block';
        b.textContent = st.open ? '' : `${st.code === 'SOLD_OUT' ? '🚫' : '⏸️'} ${st.message}`;
        b.classList.toggle('soldout', st.code === 'SOLD_OUT');
    });

    const cta = document.querySelector('.btn-goto-booking');
    if (cta) {
        if (!cta.dataset.origText) cta.dataset.origText = cta.textContent;
        cta.textContent = st.open ? cta.dataset.origText : (st.code === 'SOLD_OUT' ? '🚫 บัตรขายหมดแล้ว' : '⏸️ ปิดการขายแล้ว (ดูผังโต๊ะได้)');
    }
    const confirmBtn = btEl('btn-confirm');
    if (confirmBtn) {
        confirmBtn.disabled = !st.open;
        confirmBtn.style.opacity = st.open ? '' : '0.5';
        confirmBtn.style.cursor = st.open ? '' : 'not-allowed';
    }
    return st;
}

// ก่อนเปิดฟอร์มจอง ถามสถานะล่าสุดและเช็กจำนวนโต๊ะสูงสุดต่อการจอง (server ตรวจซ้ำเสมอ)
(function guardBookingModal() {
    const original = window.openUserBookingModal;
    window.openUserBookingModal = async function () {
        const st = await applySalesState();
        if (!st.open) { alert(st.message || 'ขณะนี้ไม่เปิดรับจอง'); return; }
        try {
            const res = await fetch(`${API_BASE}/api/settings`, { cache: 'no-store' });
            const settings = res.ok ? await res.json() : {};
            const max = Number(settings.max_tables_per_booking) || 8;
            if (Array.isArray(selectedTables) && selectedTables.length > max) {
                alert(`จองได้สูงสุด ${max} โต๊ะต่อหนึ่งรายการ กรุณาลดจำนวนโต๊ะที่เลือก`);
                return;
            }
        } catch (_) { /* ปล่อยให้ server ตรวจ */ }
        return original.apply(this, arguments);
    };
})();

// ปุ่มลัดบนเมนูหลักแอดมิน
async function renderSalesQuick() {
    const box = btEl('sales-quick');
    if (!box) return;
    const st = await fetchSalesState();
    let status = 'open';
    if (!st.open) status = st.code === 'SOLD_OUT' ? 'soldout' : 'closed';
    box.innerHTML = `
        <div class="bt-sales-chip ${status}">สถานะการขายบัตรตอนนี้: <b>${SALES_LABELS[status]}</b></div>
        <div class="bt-sales-btns">
            <button type="button" class="bt-btn green" onclick="setSalesStatus('open')" ${status === 'open' ? 'disabled' : ''}>🟢 เปิดขาย</button>
            <button type="button" class="bt-btn amber" onclick="setSalesStatus('closed')" ${status === 'closed' ? 'disabled' : ''}>⏸️ ปิดการขาย</button>
            <button type="button" class="bt-btn red" onclick="setSalesStatus('soldout')" ${status === 'soldout' ? 'disabled' : ''}>🚫 ขายหมดแล้ว</button>
            <button type="button" class="bt-btn" onclick="openSalesSettings()">⚙️ ตั้งค่าเพิ่มเติม</button>
        </div>`;
}

async function setSalesStatus(status) {
    const labels = { open: 'เปิดขายบัตร', closed: 'ปิดการขาย', soldout: 'ประกาศว่าบัตรขายหมด' };
    if (status !== 'open' && !confirm(`ต้องการ "${labels[status]}" ใช่หรือไม่?\nลูกค้าจะจองบัตรออนไลน์ไม่ได้ทันที (ขายหน้างานยังทำได้)`)) return;
    const r = await btJson('/api/settings', { method: 'PUT', body: { sales_status: status, sales_close_at: status === 'open' ? '' : undefined } });
    if (!r.ok) return alert('❌ ' + (r.data.error || 'บันทึกไม่สำเร็จ'));
    btToast(`✅ ${labels[status]}เรียบร้อย`, 'ok');
    renderSalesQuick();
    applySalesState();
}

async function openSalesSettings() {
    const r = await btJson('/api/settings/admin');
    if (!r.ok) return alert('❌ ' + (r.data.error || 'โหลดการตั้งค่าไม่สำเร็จ'));
    const s = r.data;
    btModal('bt-sales-modal', `
        <button type="button" class="bt-close" onclick="btCloseModal('bt-sales-modal')" aria-label="ปิด">&times;</button>
        <h3>⚙️ ตั้งค่าการขายบัตร</h3>
        <label class="bt-field">สถานะการขาย
            <select id="bt-sales-status">
                <option value="open">🟢 เปิดขาย</option>
                <option value="closed">⏸️ ปิดการขาย</option>
                <option value="soldout">🚫 ขายหมดแล้ว</option>
            </select>
        </label>
        <label class="bt-field">ปิดรับจองอัตโนมัติเมื่อถึงเวลา (เวลาไทย ไม่ต้องกรอกถ้าไม่ใช้)
            <input type="datetime-local" id="bt-sales-close-at">
        </label>
        <label class="bt-field">จองได้สูงสุดกี่โต๊ะต่อหนึ่งรายการ
            <input type="number" id="bt-sales-max" min="1" max="50">
        </label>
        <label class="bt-field">ปล่อยโต๊ะอัตโนมัติเมื่อรอตรวจสลิปเกินกี่ชั่วโมง (0 = ไม่ปล่อย)
            <input type="number" id="bt-sales-expire" min="0" max="720" step="1">
        </label>
        <p class="bt-hint">⚠️ ถ้าตั้งปล่อยโต๊ะอัตโนมัติ ต้องตรวจสลิปให้ทันในเวลานั้น ไม่เช่นนั้นการจองที่โอนเงินแล้วจะถูกยกเลิก</p>
        <button type="button" class="bt-btn primary full" onclick="saveSalesSettings()">💾 บันทึก</button>`);
    btEl('bt-sales-status').value = s.sales_status || 'open';
    btEl('bt-sales-close-at').value = (s.sales_close_at || '').slice(0, 16);
    btEl('bt-sales-max').value = s.max_tables_per_booking || 8;
    btEl('bt-sales-expire').value = s.pending_expire_hours || 0;
    btOpenModal('bt-sales-modal');
}

async function saveSalesSettings() {
    const r = await btJson('/api/settings', {
        method: 'PUT',
        body: {
            sales_status: btEl('bt-sales-status').value,
            sales_close_at: btEl('bt-sales-close-at').value || '',
            max_tables_per_booking: btEl('bt-sales-max').value,
            pending_expire_hours: btEl('bt-sales-expire').value || '0'
        }
    });
    if (!r.ok) return alert('❌ ' + (r.data.error || 'บันทึกไม่สำเร็จ'));
    btCloseModal('bt-sales-modal');
    btToast('✅ บันทึกการตั้งค่าการขายแล้ว', 'ok');
    renderSalesQuick();
    applySalesState();
}

// ---------- เงื่อนไขการจอง (เก็บใน DB ให้ลูกค้าทุกเครื่องเห็นตรงกัน) ----------
const DEFAULT_BOOKING_RULES = [
    'จำกัดไม่เกิน 4 ท่าน ต่อ 1 โต๊ะ',
    'กรุณามาถึงร้านก่อนเวลา 20:00 น. มิฉะนั้นระบบจะยกเลิกสิทธิ์อัตโนมัติ',
    'สอบถามเพิ่มเติม โทร: 08X-XXX-XXXX'
];

async function renderBookingRules() {
    let rules = DEFAULT_BOOKING_RULES;
    try {
        const res = await fetch(`${API_BASE}/api/settings`, { cache: 'no-store' });
        const settings = res.ok ? await res.json() : {};
        if (settings.booking_rules) {
            const parsed = JSON.parse(settings.booking_rules);
            if (Array.isArray(parsed) && parsed.length > 0) rules = parsed;
        }
    } catch (_) { /* ใช้ค่าเริ่มต้น */ }

    ['set-rule-1', 'set-rule-2', 'set-rule-3'].forEach((id, i) => {
        const el = btEl(id);
        if (el) el.value = rules[i] || '';
    });
    const ul = btEl('display-rules-list');
    if (ul) {
        ul.textContent = '';
        rules.forEach(rule => {
            const li = document.createElement('li');
            li.textContent = rule;      // textContent เสมอ ไม่ใช้ innerHTML กัน XSS
            ul.appendChild(li);
        });
    }
}

async function saveBookingRules(event) {
    if (event) event.preventDefault();
    const rules = ['set-rule-1', 'set-rule-2', 'set-rule-3']
        .map(id => (btEl(id)?.value || '').trim()).filter(Boolean);
    const r = await btJson('/api/settings', {
        method: 'PUT',
        body: { booking_rules: JSON.stringify(rules.length ? rules : DEFAULT_BOOKING_RULES) }
    });
    if (!r.ok) return alert('❌ ' + (r.data.error || 'บันทึกไม่สำเร็จ'));
    await renderBookingRules();
    alert('✅ บันทึกเงื่อนไขการจองเรียบร้อยแล้ว ลูกค้าทุกเครื่องจะเห็นข้อความใหม่');
}

// ---------- หน้ารายการจอง & ตรวจสลิป ----------
function btShortStatus(item) {
    if (item.status === 'approved') return 'อนุมัติแล้ว';
    if (item.status === 'rejected') return 'ปฏิเสธ/ยกเลิก';
    return 'รอตรวจสลิป';
}

function btAgeText(createdAt) {
    const d = btParseDbTime(createdAt);
    if (!d) return '';
    const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
    if (mins < 60) return `รอมาแล้ว ${mins} นาที`;
    const h = Math.floor(mins / 60);
    return h < 48 ? `รอมาแล้ว ${h} ชม.` : `รอมาแล้ว ${Math.floor(h / 24)} วัน`;
}

function btTicketLink(token) {
    return `${location.origin}${location.pathname.replace(/[^/]*$/, '')}ticket.html?t=${token}`;
}

async function btCopyText(text, okMsg) {
    try {
        await navigator.clipboard.writeText(text);
        btToast(okMsg || 'คัดลอกแล้ว', 'ok');
    } catch (_) {
        prompt('คัดลอกข้อความนี้:', text);
    }
}

async function renderBookingTable() {
    const tbody = btEl('full-booking-list');
    if (!tbody) return;

    const res = await apiFetch('/api/bookings/admin', { headers: { ...authHeaders() } });
    if (!res.ok) { tbody.innerHTML = ''; return; }
    const bookings = await res.json();
    window.__adminBookings = bookings;

    const sortMode = btEl('booking-sort-order')?.value || 'default';
    if (sortMode === 'table-asc' || sortMode === 'table-desc') {
        const first = (b) => (b.tableList && b.tableList[0]) || '';
        bookings.sort((a, b) => {
            const cmp = first(a).localeCompare(first(b), 'th', { numeric: true, sensitivity: 'base' });
            return sortMode === 'table-asc' ? cmp : -cmp;
        });
    }

    tbody.innerHTML = '';
    let pending = 0, approved = 0, revenue = 0;

    bookings.forEach(item => {
        if (item.status === 'pending') pending++;
        if (item.status === 'approved') { approved++; revenue += Number(item.total_amount) || 0; }

        const tr = document.createElement('tr');
        tr.setAttribute('data-status', item.status);

        const badge = item.status === 'approved'
            ? '<span class="badge-status success">อนุมัติแล้ว</span>'
            : item.status === 'rejected'
                ? '<span class="badge-status rejected">ปฏิเสธ/ยกเลิก</span>'
                : `<span class="badge-status pending">รอตรวจสลิป</span><div class="bt-age">${escapeHtml(btAgeText(item.created_at))}</div>`;

        const id = Number(item.id);
        let actions = '<span style="color:#777; font-size:0.8rem;">-</span>';
        if (item.status === 'pending') {
            actions = `<button class="btn-action approve" onclick="changeStatus(${id}, 'approved')">อนุมัติ</button>
                       <button class="btn-action reject" onclick="changeStatus(${id}, 'rejected')">ปฏิเสธ</button>`;
        } else if (item.status === 'approved') {
            actions = `<button class="btn-action approve" onclick="openReceiptForBooking(${id})">🧾 ใบเสร็จ</button>
                       <button class="btn-action" data-copy-ticket="1" style="background:#2c3e50;color:#fff;">🔗 ลิงก์บัตร</button>
                       <button class="btn-action cancel" onclick="changeStatus(${id}, 'rejected')">ยกเลิก</button>`;
        }

        const slipCell = item.slipUrl
            ? '<span class="view-slip">🔍 ดูสลิป</span>'
            : `<span style="color:#888;font-size:.8rem;">${item.isWalkin ? 'Walk-in (ไม่มีสลิป)' : '-'}</span>`;

        tr.innerHTML = `
            <td>${escapeHtml(item.booking_code)}</td>
            <td style="font-size: 0.85rem; color: #aaa;">${escapeHtml(btFmtDateTime(item.created_at))}</td>
            <td><b>${escapeHtml(item.first_name)} ${escapeHtml(item.last_name)}</b></td>
            <td>${escapeHtml(item.phone)}</td>
            <td><b style="color: #f1c40f;">${escapeHtml((item.tableList || []).join(', '))}</b></td>
            <td style="color: #22c55e; font-weight: bold;">${btMoney(item.total_amount)} ฿
                <div class="bt-age">${escapeHtml(btPaymentLabel(item.payment_method))}</div></td>
            <td>${slipCell}</td>
            <td>${badge}</td>
            <td>${actions}</td>`;

        const slipEl = tr.querySelector('.view-slip');
        if (slipEl) slipEl.addEventListener('click', () => viewSlip(item.slipUrl));
        const copyEl = tr.querySelector('[data-copy-ticket]');
        if (copyEl) copyEl.addEventListener('click', () => btCopyText(btTicketLink(item.ticket_token), '✅ คัดลอกลิงก์บัตรแล้ว ส่งให้ลูกค้าทาง LINE/แชทได้เลย'));
        tbody.appendChild(tr);
    });

    btEl('stat-total').textContent = `${bookings.length} รายการ`;
    btEl('stat-pending').textContent = `${pending} รายการ`;
    btEl('stat-approved').textContent = `${approved} รายการ`;
    const revenueEl = btEl('stat-income');
    if (revenueEl) revenueEl.textContent = `${btMoney(revenue)} ฿`;
    if (typeof filterBookings === 'function') filterBookings();
}

async function downloadBookingsCsv() {
    try {
        await btDownloadAuthed('/api/bookings/admin/export.csv', `bookings-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (err) {
        alert('❌ ' + err.message);
    }
}

// ---------- ส่งข้อมูลไป Google Sheets (อ่านจาก API ไม่ใช่จากเซลล์ในตาราง) ----------
async function exportToGoogleSheet(opts = {}) {
    const silent = !!opts.silent;
    const btn = btEl('btnExportToSheet');
    const resetBtn = () => { if (btn) { btn.disabled = false; btn.innerText = '📊 ส่งข้อมูลไป Google Sheets'; } };
    if (btn) { btn.disabled = true; btn.innerText = '⏳ กำลังบันทึกข้อมูล...'; }

    try {
        const [sRes, bRes] = await Promise.all([
            apiFetch('/api/settings/admin', { headers: { ...authHeaders() } }),
            apiFetch('/api/bookings/admin', { headers: { ...authHeaders() } })
        ]);
        const settings = sRes.ok ? await sRes.json() : {};
        const scriptUrl = settings.google_sheet_url || '';
        if (!scriptUrl) {
            if (!silent) alert('⚠️ ยังไม่ได้ตั้งค่าลิงก์ Google Sheets (ตั้งได้ที่หน้า "โปสเตอร์ & บัญชีธนาคาร")');
            return false;
        }
        const list = bRes.ok ? await bRes.json() : [];
        if (list.length === 0) {
            if (!silent) alert('⚠️ ไม่พบข้อมูลรายการจอง');
            return false;
        }
        const bookings = list.map(b => ({
            bookingId: b.booking_code,
            dateTime: btFmtDateTime(b.created_at),
            customerName: `${b.first_name} ${b.last_name}`.trim(),
            phone: b.phone,
            table: (b.tableList || []).join(', '),
            ticketPrice: `${btMoney(b.total_amount)} ฿`,
            status: btShortStatus(b)
        }));
        await fetch(scriptUrl, {
            method: 'POST', mode: 'no-cors',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bookings })
        });
        if (!silent) alert('✅ ส่งรายการลง Google Sheets เรียบร้อยแล้ว!');
        return true;
    } catch (err) {
        console.error('Export Error:', err);
        if (!silent) alert('❌ เกิดข้อผิดพลาดในการส่งข้อมูล');
        return false;
    } finally {
        resetBtn();
    }
}

// ---------- ใบเสร็จ ----------
async function openReceiptForBooking(bookingId) {
    const r = await btJson(`/api/receipts?bookingId=${Number(bookingId)}`);
    if (!r.ok) return alert('❌ ' + (r.data.error || 'โหลดใบเสร็จไม่สำเร็จ'));
    const issued = (r.data || []).find(x => x.status === 'issued');
    if (issued) return showReceipt(issued);
    const booking = (window.__adminBookings || []).find(b => Number(b.id) === Number(bookingId));
    if (booking) openIssueReceipt(booking);
}

async function openIssueReceipt(b) {
    const s = (await btJson('/api/settings/admin')).data || {};
    const opt = (v, t) => `<option value="${v}" ${b.payment_method === v ? 'selected' : ''}>${t}</option>`;
    btModal('bt-receipt-issue', `
        <button type="button" class="bt-close" onclick="btCloseModal('bt-receipt-issue')" aria-label="ปิด">&times;</button>
        <h3>🧾 ออกใบเสร็จรับเงิน</h3>
        <p class="bt-hint">${escapeHtml(b.first_name)} ${escapeHtml(b.last_name)} · ${escapeHtml(b.booking_code)} · โต๊ะ ${escapeHtml((b.tableList || []).join(', '))}</p>
        <label class="bt-field">ยอดเงิน (บาท)<input type="number" id="bt-rc-amount" min="0" value="${Number(b.total_amount) || 0}"></label>
        <label class="bt-field">วิธีชำระเงิน
            <select id="bt-rc-method">${opt('transfer', 'โอนเงิน')}${opt('cash', 'เงินสด')}${opt('promptpay', 'พร้อมเพย์')}</select></label>
        <label class="bt-field">หมายเหตุ (ถ้ามี)<input type="text" id="bt-rc-note" maxlength="300"></label>
        <details class="bt-details"><summary>ข้อมูลร้านที่แสดงบนใบเสร็จ</summary>
            <label class="bt-field">ชื่อร้าน/นิติบุคคล<input type="text" id="bt-rc-shop" value="${escapeHtml(s.receipt_shop_name || 'ร้านบ้านตะลุง')}"></label>
            <label class="bt-field">ที่อยู่<input type="text" id="bt-rc-addr" value="${escapeHtml(s.receipt_shop_address || '')}"></label>
            <label class="bt-field">เลขประจำตัวผู้เสียภาษี (ถ้ามี)<input type="text" id="bt-rc-tax" value="${escapeHtml(s.receipt_tax_id || '')}"></label>
            <label class="bt-field">ข้อความท้ายใบเสร็จ<input type="text" id="bt-rc-foot" value="${escapeHtml(s.receipt_footer || 'ขอบคุณที่ใช้บริการ')}"></label>
        </details>
        <p class="bt-hint">เลขที่ใบเสร็จจะรันต่อเนื่องอัตโนมัติ ออกแล้วแก้ไขไม่ได้ (ถ้าผิดให้ยกเลิก/void แล้วออกใหม่)</p>
        <button type="button" class="bt-btn primary full" id="bt-rc-submit">✅ ออกใบเสร็จ</button>`);
    btEl('bt-rc-submit').addEventListener('click', async () => {
        const btn = btEl('bt-rc-submit'); btn.disabled = true;
        await btJson('/api/settings', { method: 'PUT', body: {
            receipt_shop_name: btEl('bt-rc-shop').value, receipt_shop_address: btEl('bt-rc-addr').value,
            receipt_tax_id: btEl('bt-rc-tax').value, receipt_footer: btEl('bt-rc-foot').value
        } });
        const r = await btJson('/api/receipts', { method: 'POST', body: {
            bookingId: Number(b.id), amount: Number(btEl('bt-rc-amount').value),
            paymentMethod: btEl('bt-rc-method').value, note: btEl('bt-rc-note').value
        } });
        btn.disabled = false;
        if (!r.ok) return alert('❌ ' + (r.data.error || 'ออกใบเสร็จไม่สำเร็จ'));
        btCloseModal('bt-receipt-issue');
        showReceipt(r.data);
    });
    btOpenModal('bt-receipt-issue');
}

async function showReceipt(rc) {
    const s = (await btJson('/api/settings/admin')).data || {};
    const issuedAt = btParseDbTime(rc.issued_at);
    const dateText = issuedAt ? issuedAt.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'long', timeStyle: 'short' }) : '-';
    const isVoid = rc.status === 'void';
    btModal('bt-receipt-view', `
        <div class="no-print bt-modal-head">
            <button type="button" class="bt-close" onclick="btCloseModal('bt-receipt-view')" aria-label="ปิด">&times;</button>
            <h3>🧾 ใบเสร็จ ${escapeHtml(rc.receipt_no)}</h3>
        </div>
        <div id="bt-receipt-paper" class="bt-receipt-paper ${isVoid ? 'is-void' : ''}">
            ${isVoid ? '<div class="bt-void-mark">ยกเลิกแล้ว</div>' : ''}
            <div class="bt-rc-shop">${escapeHtml(s.receipt_shop_name || 'ร้านบ้านตะลุง')}</div>
            ${s.receipt_shop_address ? `<div class="bt-rc-small">${escapeHtml(s.receipt_shop_address)}</div>` : ''}
            ${s.receipt_tax_id ? `<div class="bt-rc-small">เลขประจำตัวผู้เสียภาษี ${escapeHtml(s.receipt_tax_id)}</div>` : ''}
            <h2 class="bt-rc-title">ใบเสร็จรับเงิน</h2>
            <table class="bt-rc-table">
                <tr><td>เลขที่</td><td><b>${escapeHtml(rc.receipt_no)}</b></td></tr>
                <tr><td>วันที่</td><td>${escapeHtml(dateText)}</td></tr>
                <tr><td>ได้รับเงินจาก</td><td>${escapeHtml(rc.customer_name)}</td></tr>
                <tr><td>รหัสการจอง</td><td>${escapeHtml(rc.booking_code || '-')}</td></tr>
                <tr><td>รายการ</td><td>บัตรเข้าชมคอนเสิร์ต โต๊ะ ${escapeHtml(rc.tables || '-')}</td></tr>
                <tr><td>วิธีชำระเงิน</td><td>${escapeHtml(btPaymentLabel(rc.payment_method))}</td></tr>
                ${rc.note ? `<tr><td>หมายเหตุ</td><td>${escapeHtml(rc.note)}</td></tr>` : ''}
                <tr class="bt-rc-total"><td>จำนวนเงินรวม</td><td><b>${btMoney(rc.amount)} บาท</b></td></tr>
            </table>
            ${isVoid ? `<div class="bt-rc-small">ยกเลิกเมื่อ ${escapeHtml(btFmtDateTime(rc.voided_at))} · เหตุผล: ${escapeHtml(rc.void_reason || '-')}</div>` : ''}
            <div class="bt-rc-sign"><div>ผู้รับเงิน ${escapeHtml(rc.issued_by || '')}</div></div>
            <div class="bt-rc-small center">${escapeHtml(s.receipt_footer || 'ขอบคุณที่ใช้บริการ')}</div>
        </div>
        <div class="no-print bt-row">
            <button type="button" class="bt-btn primary" onclick="printReceipt()">🖨️ พิมพ์ / บันทึกเป็น PDF</button>
            ${isVoid ? '' : `<button type="button" class="bt-btn red" id="bt-rc-void">ยกเลิกใบเสร็จ</button>`}
        </div>`, { wide: true });
    const voidBtn = btEl('bt-rc-void');
    if (voidBtn) voidBtn.addEventListener('click', async () => {
        const reason = prompt(`ยกเลิกใบเสร็จ ${rc.receipt_no}\nกรุณาระบุเหตุผล:`);
        if (!reason || !reason.trim()) return;
        const r = await btJson(`/api/receipts/${Number(rc.id)}/void`, { method: 'POST', body: { reason: reason.trim() } });
        if (!r.ok) return alert('❌ ' + (r.data.error || 'ยกเลิกไม่สำเร็จ'));
        btToast('ยกเลิกใบเสร็จแล้ว', 'ok');
        btCloseModal('bt-receipt-view');
        if (btEl('bt-receipt-list') && btEl('bt-receipt-list').style.display !== 'none') openReceiptList();
    });
    btOpenModal('bt-receipt-view');
}

function printReceipt() {
    document.body.classList.add('bt-printing');
    const done = () => { document.body.classList.remove('bt-printing'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
}

async function openReceiptList() {
    const r = await btJson('/api/receipts');
    if (!r.ok) return alert('❌ ' + (r.data.error || 'โหลดใบเสร็จไม่สำเร็จ'));
    window.__receiptList = r.data;
    const rows = r.data.map(x => `
        <tr class="${x.status === 'void' ? 'void' : ''}">
            <td><b>${escapeHtml(x.receipt_no)}</b></td>
            <td>${escapeHtml(btFmtDateTime(x.issued_at))}</td>
            <td>${escapeHtml(x.customer_name)}</td>
            <td>${escapeHtml(x.tables || '')}</td>
            <td style="text-align:right;">${btMoney(x.amount)}</td>
            <td>${x.status === 'void' ? 'ยกเลิก' : 'ปกติ'}</td>
            <td><button type="button" class="bt-btn small" data-rc="${Number(x.id)}">เปิด</button></td>
        </tr>`).join('');
    const total = r.data.filter(x => x.status === 'issued').reduce((s, x) => s + Number(x.amount), 0);
    btModal('bt-receipt-list', `
        <button type="button" class="bt-close" onclick="btCloseModal('bt-receipt-list')" aria-label="ปิด">&times;</button>
        <h3>🧾 ใบเสร็จทั้งหมด</h3>
        <p class="bt-hint">ใบเสร็จที่ใช้งานอยู่ ${r.data.filter(x => x.status === 'issued').length} ใบ รวม ${btMoney(total)} บาท (ใบเสร็จไม่ถูกลบเมื่อกด "สิ้นสุดคอนเสิร์ต")</p>
        <div class="bt-table-wrap"><table class="bt-table">
            <thead><tr><th>เลขที่</th><th>วันที่</th><th>ลูกค้า</th><th>โต๊ะ</th><th>บาท</th><th>สถานะ</th><th></th></tr></thead>
            <tbody>${rows || '<tr><td colspan="7" style="text-align:center;color:#888;">ยังไม่มีใบเสร็จ</td></tr>'}</tbody>
        </table></div>`, { wide: true });
    btEl('bt-receipt-list').querySelectorAll('[data-rc]').forEach(b => b.addEventListener('click', () => {
        const rc = window.__receiptList.find(x => Number(x.id) === Number(b.dataset.rc));
        if (rc) showReceipt(rc);
    }));
    btOpenModal('bt-receipt-list');
}

// ---------- สิ้นสุดคอนเสิร์ต (สำรองข้อมูลก่อนลบ + ยืนยันรหัสผ่านที่ server) ----------
function endConcertWithAuth() {
    btModal('bt-end-concert', `
        <button type="button" class="bt-close" onclick="btCloseModal('bt-end-concert')" aria-label="ปิด">&times;</button>
        <h3>🏁 สิ้นสุดคอนเสิร์ต</h3>
        <div class="bt-warn">
            ระบบจะ <b>ล้างรายการจองและสถานะเช็กอินทั้งหมด</b> (คงผังโต๊ะ ราคา และใบเสร็จไว้)<br>
            ก่อนล้าง ระบบจะ <b>สำรองข้อมูลการจองทั้งหมดไว้ในฐานข้อมูล</b> และดาวน์โหลดไฟล์ CSV ให้อัตโนมัติ
            ถ้าสำรองไม่สำเร็จ จะไม่มีข้อมูลถูกลบ
        </div>
        <label class="bt-field">กรอกรหัสผ่านแอดมินเพื่อยืนยัน
            <input type="password" id="bt-end-pw" autocomplete="current-password"></label>
        <label class="bt-check"><input type="checkbox" id="bt-end-purge"> ลบรูปสลิปของงานนี้ออกจาก Cloudinary ด้วย (สลิปมีข้อมูลบัญชีลูกค้า)</label>
        <p id="bt-end-msg" class="bt-msg"></p>
        <button type="button" class="bt-btn red full" id="bt-end-go">🏁 ยืนยันสิ้นสุดคอนเสิร์ต</button>`);
    btEl('bt-end-go').addEventListener('click', runEndConcert);
    btEl('bt-end-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') runEndConcert(); });
    btOpenModal('bt-end-concert');
    setTimeout(() => btEl('bt-end-pw').focus(), 50);
}

async function runEndConcert() {
    const pw = btEl('bt-end-pw').value;
    const msg = btEl('bt-end-msg');
    const btn = btEl('bt-end-go');
    if (!pw) { msg.textContent = 'กรุณากรอกรหัสผ่าน'; return; }
    btn.disabled = true;
    try {
        msg.textContent = '⏳ กำลังดาวน์โหลดไฟล์สำรอง...';
        try { await btDownloadAuthed('/api/bookings/admin/export.csv', `bookings-backup-${new Date().toISOString().slice(0, 10)}.csv`); }
        catch (e) { console.warn('ดาวน์โหลด CSV สำรองไม่สำเร็จ (ยังมีข้อมูลสำรองบน server):', e.message); }

        msg.textContent = '⏳ กำลังส่งสำรองไป Google Sheets (ถ้าตั้งค่าไว้)...';
        await exportToGoogleSheet({ silent: true });

        msg.textContent = '⏳ กำลังสำรองและล้างข้อมูล...';
        const r = await btJson('/api/bookings/end-concert', { method: 'POST', body: { password: pw } });
        if (!r.ok) {
            msg.textContent = '❌ ' + (r.data.error || 'ไม่สำเร็จ');
            btn.disabled = false;
            return;
        }

        if (btEl('bt-end-purge').checked && r.data.archiveId) {
            for (let i = 0; i < 80; i++) {
                const p = await btJson(`/api/bookings/admin/archives/${r.data.archiveId}/purge-slips`, { method: 'POST' });
                if (!p.ok) { msg.textContent = '⚠️ ลบรูปสลิปไม่ครบ: ' + (p.data.error || ''); break; }
                msg.textContent = `⏳ กำลังลบรูปสลิป... เหลืออีก ${p.data.remaining} รูป`;
                if (p.data.remaining === 0) break;
            }
        }
        alert('✅ ' + r.data.message);
        location.reload();
    } catch (err) {
        msg.textContent = '❌ ' + err.message;
        btn.disabled = false;
    }
}

// ---------- ข้อมูลงานที่ผ่านมา (ที่สำรองไว้ตอนสิ้นสุดคอนเสิร์ต) ----------
async function openArchives() {
    const r = await btJson('/api/bookings/admin/archives');
    if (!r.ok) return alert('❌ ' + (r.data.error || 'โหลดไม่สำเร็จ'));
    const rows = r.data.map(a => `
        <tr><td>#${Number(a.id)}</td><td>${escapeHtml(btFmtDateTime(a.ended_at))}</td>
        <td>${escapeHtml(a.concert_title || '-')}</td><td>${Number(a.booking_count)}</td>
        <td><button type="button" class="bt-btn small" data-csv="${Number(a.id)}">⬇️ CSV</button>
            <button type="button" class="bt-btn small red" data-purge="${Number(a.id)}">ลบรูปสลิป</button></td></tr>`).join('');
    btModal('bt-archives', `
        <button type="button" class="bt-close" onclick="btCloseModal('bt-archives')" aria-label="ปิด">&times;</button>
        <h3>📦 ข้อมูลงานที่ผ่านมา (สำรองอัตโนมัติ)</h3>
        <div class="bt-table-wrap"><table class="bt-table">
            <thead><tr><th>#</th><th>สิ้นสุดเมื่อ</th><th>งาน</th><th>รายการ</th><th></th></tr></thead>
            <tbody>${rows || '<tr><td colspan="5" style="text-align:center;color:#888;">ยังไม่มีข้อมูลสำรอง</td></tr>'}</tbody>
        </table></div>`, { wide: true });
    const box = btEl('bt-archives');
    box.querySelectorAll('[data-csv]').forEach(b => b.addEventListener('click', async () => {
        try { await btDownloadAuthed(`/api/bookings/admin/archives/${Number(b.dataset.csv)}/csv`, `bookings-archive-${Number(b.dataset.csv)}.csv`); }
        catch (e) { alert('❌ ' + e.message); }
    }));
    box.querySelectorAll('[data-purge]').forEach(b => b.addEventListener('click', async () => {
        if (!confirm('ลบรูปสลิปของงานนี้ออกจาก Cloudinary ถาวรใช่หรือไม่? (ข้อมูลการจองยังอยู่)')) return;
        b.disabled = true;
        for (let i = 0; i < 80; i++) {
            const p = await btJson(`/api/bookings/admin/archives/${Number(b.dataset.purge)}/purge-slips`, { method: 'POST' });
            if (!p.ok) { alert('❌ ' + (p.data.error || 'ไม่สำเร็จ')); break; }
            b.textContent = `เหลือ ${p.data.remaining}`;
            if (p.data.remaining === 0) { btToast('ลบรูปสลิปครบแล้ว', 'ok'); b.textContent = 'ลบแล้ว'; break; }
        }
    }));
    btOpenModal('bt-archives');
}

function openScanFromHub() {
    openAdminInspect();
    setTimeout(() => { if (typeof openScanOverlay === 'function') openScanOverlay(); }, 400);
}

// ---------- เริ่มต้น ----------
document.addEventListener('DOMContentLoaded', () => {
    applyRoleUI();
    applySalesState();
    renderBookingRules();
    setInterval(() => { if (!document.hidden) applySalesState(); }, 60 * 1000);
});
