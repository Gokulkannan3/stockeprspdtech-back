const { Pool } = require('pg');
const PDFDocument = require('pdfkit');

const pool = new Pool({
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
  // ssl: {
  //   rejectUnauthorized: false,
  // },
});

// ─── Ensure tables exist ────────────────────────────────────────────────────
const ensureTables = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.purchases (
      id SERIAL PRIMARY KEY,
      purchase_number TEXT NOT NULL UNIQUE,
      purchase_date DATE NOT NULL,
      supplier_name TEXT NOT NULL,
      address TEXT DEFAULT '',
      gstin TEXT DEFAULT '',
      invoice_number TEXT DEFAULT '',
      agent_name TEXT DEFAULT 'DIRECT',
      "from" TEXT DEFAULT 'SIVAKASI',
      "to" TEXT DEFAULT 'SIVAKASI',
      "through" TEXT DEFAULT '',
      items JSONB DEFAULT '[]',
      total NUMERIC DEFAULT 0,
      extra_charges JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.purchase_payments (
      id SERIAL PRIMARY KEY,
      purchase_id INTEGER REFERENCES public.purchases(id) ON DELETE CASCADE,
      amount_paid NUMERIC NOT NULL,
      payment_method TEXT NOT NULL,
      bank_name TEXT,
      paid_to TEXT,
      transaction_date DATE DEFAULT CURRENT_DATE,
      admin_id INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.purchase_dispatch_logs (
      id SERIAL PRIMARY KEY,
      purchase_id INTEGER REFERENCES public.purchases(id) ON DELETE CASCADE,
      product_index INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      brand TEXT,
      dispatched_cases INTEGER NOT NULL DEFAULT 0,
      dispatched_qty INTEGER NOT NULL DEFAULT 0,
      godown TEXT,
      transport_name TEXT,
      lr_number TEXT,
      allocated_by TEXT,
      dispatched_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.godown_transfer_challans (
      id SERIAL PRIMARY KEY,
      challan_number TEXT UNIQUE,
      transfer_date DATE DEFAULT CURRENT_DATE,
      source_godown_id INTEGER,
      target_godown_id INTEGER,
      source_godown_name TEXT,
      target_godown_name TEXT,
      product_details JSONB DEFAULT '[]',
      transport_name TEXT,
      lr_number TEXT,
      delivery_person TEXT,
      performed_by TEXT,
      from_place TEXT,
      to_place TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    -- Add paid_to column if upgrading existing installs
    ALTER TABLE public.purchase_payments ADD COLUMN IF NOT EXISTS paid_to TEXT;

    -- Add is_closed column for admin bill close feature
    ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS is_closed BOOLEAN DEFAULT FALSE;

    -- Add allocated_by if upgrading
    ALTER TABLE public.purchase_dispatch_logs ADD COLUMN IF NOT EXISTS allocated_by TEXT;

    CREATE SEQUENCE IF NOT EXISTS purchase_sequence START 1;
    CREATE SEQUENCE IF NOT EXISTS challan_sequence START 1;
  `);
};

ensureTables().catch(err => console.error('Purchase table init error:', err));

// ─── Helpers ─────────────────────────────────────────────────────────────────
const formatDate = (dateInput) => {
  if (!dateInput) return '—';
  let date;
  if (typeof dateInput === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
      const [y, m, d] = dateInput.split('-');
      return `${d}/${m}/${y}`;
    }
    date = new Date(dateInput);
  } else if (dateInput instanceof Date) {
    date = dateInput;
  } else {
    return 'Invalid';
  }
  if (isNaN(date?.getTime())) return 'Invalid Date';
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
};

const getNextPurchaseNumber = async () => {
  const res = await pool.query(`SELECT nextval('purchase_sequence') AS seq`);
  return String(res.rows[0].seq).padStart(4, '0');
};

// ─── PDF Generator ────────────────────────────────────────────────────────────
const generatePurchasePDFBuffer = (data) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const safeNum = (val) => (parseFloat(val) || 0).toFixed(2);
    const safeStr = (val) => (val || '').toString();

    const purchase_number = safeStr(data.purchase_number || 'N/A');
    const purchase_date = data.purchase_date || null;
    const supplier_name = safeStr(data.supplier_name || 'N/A');
    const address = safeStr(data.address || '');
    const gstin = safeStr(data.gstin || '');
    const invoice_number = safeStr(data.invoice_number || '');
    const agent_name = safeStr(data.agent_name || 'DIRECT');
    const from = safeStr(data.from || 'SIVAKASI');
    const to = safeStr(data.to || 'SIVAKASI');
    const through = safeStr(data.through || '');
    const items = Array.isArray(data.items) ? data.items : [];
    const subtotal = safeNum(data.subtotal);
    const packingCharges = safeNum(data.packingCharges);
    const packing_percent = parseFloat(data.packing_percent) || 3.0;
    const addlDiscountAmt = safeNum(data.addlDiscountAmt);
    const taxableUsed = safeNum(data.taxableUsed || data.taxableAmount);
    const cgstAmt = safeNum(data.cgstAmt);
    const sgstAmt = safeNum(data.sgstAmt);
    const igstAmt = safeNum(data.igstAmt);
    const roundOff = safeNum(data.roundOff);
    const grandTotal = parseFloat(data.grandTotal) || 0;
    const totalCases = parseInt(data.totalCases) || 0;

    // Title Header
    doc.fontSize(20).font('Helvetica-Bold').fillColor('#0f172a').text('PURCHASE ORDER', { align: 'center' });
    doc.fontSize(9).font('Helvetica').fillColor('#64748b').text('OFFICIAL SUPPLIER PURCHASE DOCUMENT', { align: 'center' }).moveDown(0.5);
    doc.moveTo(40, doc.y).lineTo(555, doc.y).lineWidth(1).strokeColor('#cbd5e1').stroke().moveDown(0.8);

    const leftX = 40;
    const rightX = 305;
    const startY = doc.y;

    // Supplier Info Box
    doc.rect(leftX, startY, 250, 70).fillColor('#f8fafc').fill().strokeColor('#cbd5e1').stroke();
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#64748b').text('SUPPLIER DETAILS', leftX + 10, startY + 8);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a').text(supplier_name, leftX + 10, startY + 20);
    doc.font('Helvetica').fontSize(9).fillColor('#334155').text(`Address: ${address || '—'}`, leftX + 10, startY + 35);
    if (gstin) doc.font('Helvetica').fontSize(9).fillColor('#334155').text(`GSTIN: ${gstin}`, leftX + 10, startY + 48);

    // Purchase Order Info Box
    doc.rect(rightX, startY, 250, 70).fillColor('#f8fafc').fill().strokeColor('#cbd5e1').stroke();
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#64748b').text('PO & INVOICE DETAILS', rightX + 10, startY + 8);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a').text(`PO No: ${purchase_number}`, rightX + 10, startY + 20);
    doc.font('Helvetica').fontSize(9).fillColor('#334155').text(`Date: ${formatDate(purchase_date)}`, rightX + 10, startY + 35);
    doc.font('Helvetica').fontSize(9).fillColor('#334155').text(`Invoice No: ${invoice_number || '—'} | Cases: ${totalCases}`, rightX + 10, startY + 48);

    let y = startY + 80;
    const tableStartX = 40;
    const tableWidth = 515;
    const colWidths = [35, 155, 45, 45, 55, 60, 65, 55];
    const rowHeight = 20;
    const cellPadding = 3;

    const headers = ['S.No', 'Product Name', 'Cases', 'Per', 'Qty', 'Rate', 'Amount', 'Godown'];

    // Table Header
    const headerTop = y;
    doc.rect(tableStartX, headerTop, tableWidth, rowHeight).fillColor('#1e293b').fill();
    doc.fillColor('white').font('Helvetica-Bold').fontSize(9);
    let x = tableStartX;
    headers.forEach((h, i) => {
      doc.text(h, x + cellPadding, y + cellPadding + 2, {
        width: colWidths[i] - 2 * cellPadding,
        align: 'center'
      });
      x += colWidths[i];
    });

    y += rowHeight;

    // Table Rows
    doc.font('Helvetica').fontSize(9);
    items.forEach((item, idx) => {
      x = tableStartX;
      const rate = parseFloat(item.rate_per_box) || 0;
      const amount = parseFloat(item.amount) || 0;

      const row = [
        (item.s_no || idx + 1).toString(),
        item.productname || '',
        (item.cases || 0).toString(),
        (item.per_case || 1).toString(),
        (item.quantity || 0).toString(),
        rate.toFixed(2),
        amount.toFixed(2),
        item.godown || from
      ];

      const rowBg = idx % 2 === 0 ? '#f8fafc' : '#ffffff';
      doc.rect(tableStartX, y, tableWidth, rowHeight).fillColor(rowBg).fill().strokeColor('#e2e8f0').stroke();

      doc.fillColor('#334155');
      row.forEach((text, i) => {
        const align = (i === 1) ? 'left' : (i >= 5 && i <= 6 ? 'right' : 'center');
        doc.text(text, x + cellPadding, y + cellPadding + 2, {
          width: colWidths[i] - 2 * cellPadding,
          align
        });
        x += colWidths[i];
      });

      y += rowHeight;
    });

    y += 15;
    const transportStartY = y;

    // Transport Details Box
    doc.rect(40, transportStartY, 245, 65).fillColor('#f8fafc').fill().strokeColor('#cbd5e1').stroke();
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#64748b').text('RECEIPT & DISPATCH DETAILS', 50, transportStartY + 8);
    doc.font('Helvetica').fontSize(9).fillColor('#334155');
    doc.text(`From: ${from}`, 50, transportStartY + 22);
    doc.text(`To: ${to}`, 50, transportStartY + 35);
    doc.text(`Carrier: ${through || '—'}`, 50, transportStartY + 48);

    // Summary Totals Box
    const labelX = 305;
    const valueX = 450;
    const valueWidth = 100;
    const totals = [
      ['GOODS VALUE', subtotal],
      ...(addlDiscountAmt > 0 ? [['SPECIAL DISCOUNT', `-${addlDiscountAmt}`]] : []),
      ...(packingCharges > 0 ? [[`PACKING @ ${packing_percent}%`, packingCharges]] : []),
      ['TAXABLE VALUE', taxableUsed],
      ...(cgstAmt > 0 ? [['CGST @ 9%', cgstAmt]] : []),
      ...(sgstAmt > 0 ? [['SGST @ 9%', sgstAmt]] : []),
      ...(igstAmt > 0 ? [['IGST @ 18%', igstAmt]] : []),
      ['ROUND OFF', roundOff],
    ];

    let ty = transportStartY;
    doc.font('Helvetica').fontSize(9);
    totals.forEach(([label, value]) => {
      if (!label) return;
      doc.fillColor('#475569').text(label, labelX, ty, { align: 'left' });
      if (value !== undefined) {
        doc.fillColor('#0f172a').font('Helvetica-Bold').text(value, valueX, ty, { width: valueWidth, align: 'right' }).font('Helvetica');
      }
      ty += 14;
    });

    const netY = ty + 4;
    doc.rect(labelX, netY - 2, 250, 22).fillColor('#1e293b').fill();
    doc.font('Helvetica-Bold').fontSize(10).fillColor('white')
      .text('NET PURCHASE TOTAL', labelX + 8, netY + 4)
      .text(`₹${grandTotal.toFixed(2)}`, valueX, netY + 4, { width: valueWidth - 8, align: 'right' });

    // Footer & Signature
    const footerY = Math.max(y, ty) + 40;
    doc.font('Helvetica').fontSize(8).fillColor('#64748b');
    doc.text('Note: 1. Subject to Sivakasi Jurisdiction. 2. E. & O.E.', 40, footerY);

    const sigY = footerY + 20;
    doc.text('Authorised Signatory', 420, sigY + 25);
    doc.moveTo(420, sigY + 20).lineTo(555, sigY + 20).strokeColor('#94a3b8').stroke();

    doc.end();
  });
};

// ─── Create Purchase ──────────────────────────────────────────────────────────
exports.createPurchase = async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      supplier_name,
      address,
      gstin,
      invoice_number,
      agent_name = 'DIRECT',
      from: fromLoc = 'SIVAKASI',
      to: toLoc = 'SIVAKASI',
      through,
      additional_discount = 0,
      packing_percent = 3.0,
      taxable_value,
      items = [],
      apply_processing_fee = false,
      apply_cgst = false,
      apply_sgst = false,
      apply_igst = false,
      performed_by,
    } = req.body;

    if (!supplier_name || !items.length) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    await client.query('BEGIN');

    const seq = await getNextPurchaseNumber();
    const purchase_number = `PO-${seq}`;
    const purchase_date = new Date().toISOString().split('T')[0];

    let subtotal = 0;
    let totalCases = 0;
    const processedItems = [];

    for (const [idx, item] of items.entries()) {
      const {
        productname,
        brand,
        cases,
        per_case,
        discount_percent = 0,
        godown,
        rate_per_box,
      } = item;

      if (!productname || !cases || !per_case || rate_per_box === undefined) {
        throw new Error(`Invalid item at index ${idx}`);
      }

      const qty = Number(cases) * Number(per_case);
      const amountBefore = qty * Number(rate_per_box);
      const discountAmt = amountBefore * (Number(discount_percent) / 100);
      const finalAmt = amountBefore - discountAmt;

      subtotal += finalAmt;
      totalCases += Number(cases);

      processedItems.push({
        s_no: idx + 1,
        productname: productname.trim(),
        brand: brand?.trim() || '',
        cases: Number(cases),
        per_case: Number(per_case),
        quantity: qty,
        rate_per_box: Number(rate_per_box),
        discount_percent: Number(discount_percent),
        amount: Number(finalAmt.toFixed(2)),
        godown: godown?.trim() || fromLoc,
        product_type: item.product_type || 'general'
      });

      // Auto-register item into Inventory master list (public.products and public.<type>)
      try {
        await client.query('SAVEPOINT auto_inventory');
        const pName = productname.trim();
        const bName = brand?.trim() || 'General';
        const pPrice = Number(rate_per_box) || 0;
        const perCaseNum = Number(per_case) || 1;
        const pType = (item.product_type || 'general').toLowerCase().replace(/\s+/g, '_');

        await client.query(`
          CREATE TABLE IF NOT EXISTS public.brand (
            id BIGSERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            agent_name VARCHAR(100),
            CONSTRAINT brand_name_unique UNIQUE (name)
          )
        `);
        const formattedBrand = bName.toLowerCase().replace(/\s+/g, '_');
        await client.query('INSERT INTO public.brand (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [formattedBrand]);

        await client.query(`
          CREATE TABLE IF NOT EXISTS public.products (
            id SERIAL PRIMARY KEY,
            product_type TEXT NOT NULL,
            CONSTRAINT products_product_type_unique UNIQUE (product_type)
          )
        `);
        
        // Manual duplicates check in products to avoid hitting constraint violation if column isn't unique yet
        const checkProd = await client.query('SELECT id FROM public.products WHERE product_type = $1', [pType]);
        if (checkProd.rows.length === 0) {
          try {
            await client.query('INSERT INTO public.products (product_type) VALUES ($1) ON CONFLICT (product_type) DO NOTHING', [pType]);
          } catch (_) {
            await client.query('INSERT INTO public.products (product_type) VALUES ($1)', [pType]);
          }
        }

        await client.query(`
          CREATE TABLE IF NOT EXISTS public."${pType}" (
            id BIGSERIAL PRIMARY KEY,
            productname TEXT NOT NULL,
            price NUMERIC(10,2) NOT NULL,
            per_case INTEGER NOT NULL,
            brand TEXT NOT NULL
          )
        `);

        const dupCheck = await client.query(
          `SELECT id FROM public."${pType}" WHERE LOWER(productname) = LOWER($1) AND LOWER(brand) = LOWER($2)`,
          [pName, bName]
        );
        if (dupCheck.rows.length === 0) {
          await client.query(
            `INSERT INTO public."${pType}" (productname, price, per_case, brand) VALUES ($1, $2, $3, $4)`,
            [pName, pPrice, perCaseNum, bName]
          );
        }
        await client.query('RELEASE SAVEPOINT auto_inventory');
      } catch (invErr) {
        await client.query('ROLLBACK TO SAVEPOINT auto_inventory');
        console.log('Auto-inventory registration log:', invErr.message);
      }
    }

    const packingCharges = apply_processing_fee ? subtotal * (packing_percent / 100) : 0;
    const extraTaxable = taxable_value ? Number(taxable_value) : 0;
    const taxableAmount = subtotal + packingCharges + extraTaxable;
    const discountAmtTotal = taxableAmount * (additional_discount / 100);
    const netTaxable = taxableAmount - discountAmtTotal;

    let cgst = 0, sgst = 0, igst = 0;
    if (apply_igst) igst = netTaxable * 0.18;
    else if (apply_cgst && apply_sgst) {
      cgst = netTaxable * 0.09;
      sgst = netTaxable * 0.09;
    }

    const totalTax = cgst + sgst + igst;
    const grandTotal = Math.round(netTaxable + totalTax);
    const roundOff = grandTotal - (netTaxable + totalTax);

    const purchaseInsert = await client.query(
      `INSERT INTO public.purchases (
        purchase_number, purchase_date, supplier_name, address, gstin, invoice_number, agent_name,
        "from", "to", "through", items, total, extra_charges
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [
        purchase_number, purchase_date, supplier_name, address || '', gstin || '',
        invoice_number || '', agent_name, fromLoc, toLoc, through || '',
        JSON.stringify(processedItems), grandTotal,
        JSON.stringify({
          packing_percent, additional_discount, taxable_value: extraTaxable,
          apply_processing_fee, apply_cgst, apply_sgst, apply_igst
        })
      ]
    );
    const purchase_id = purchaseInsert.rows[0].id;

    // ─── Auto-Allocate Stock to Godowns ──────────────────────────────────────
    const allocationSummary = [];
    for (const [idx, item] of processedItems.entries()) {
      if (!item.godown || item.cases <= 0) continue;
      const godownRaw = item.godown.trim();
      const godownFormatted = godownRaw.toLowerCase().replace(/\s+/g, '_');

      try {
        await client.query('SAVEPOINT sp_godown_alloc');

        // Ensure godown table & find godown
        await client.query(`CREATE TABLE IF NOT EXISTS public.godown (id BIGSERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL UNIQUE)`);
        let gRes = await client.query(`SELECT id FROM public.godown WHERE name = $1 OR name = $2`, [godownFormatted, godownRaw]);
        let godown_id;
        if (gRes.rows.length === 0) {
          const gIns = await client.query(`INSERT INTO public.godown (name) VALUES ($1) RETURNING id`, [godownFormatted]);
          godown_id = gIns.rows[0].id;
        } else {
          godown_id = gRes.rows[0].id;
        }

        // Ensure brand
        await client.query(`CREATE TABLE IF NOT EXISTS public.brand (id BIGSERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL UNIQUE, agent_name VARCHAR(100))`);
        const fmtBrand = (item.brand || 'general').toLowerCase().replace(/\s+/g, '_');
        let bRes = await client.query(`SELECT id FROM public.brand WHERE name = $1`, [fmtBrand]);
        let brand_id;
        if (bRes.rows.length === 0) {
          const bIns = await client.query(`INSERT INTO public.brand (name) VALUES ($1) RETURNING id`, [fmtBrand]);
          brand_id = bIns.rows[0].id;
        } else {
          brand_id = bRes.rows[0].id;
        }

        // Ensure stock table
        await client.query(`
          CREATE TABLE IF NOT EXISTS public.stock (
            id BIGSERIAL PRIMARY KEY,
            godown_id INTEGER REFERENCES public.godown(id) ON DELETE CASCADE,
            product_type VARCHAR(100) NOT NULL,
            productname VARCHAR(255) NOT NULL,
            brand VARCHAR(100) NOT NULL,
            current_cases INTEGER NOT NULL DEFAULT 0,
            per_case INTEGER NOT NULL,
            date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_taken_date TIMESTAMP NULL,
            taken_cases INTEGER DEFAULT 0,
            brand_id INTEGER REFERENCES public.brand(id),
            CONSTRAINT unique_stock_entry UNIQUE (godown_id, product_type, productname, brand)
          )
        `);

        const productType = (item.product_type || 'general').toLowerCase().replace(/\s+/g, '_');
        const existStock = await client.query(
          `SELECT id, current_cases FROM public.stock WHERE godown_id = $1 AND LOWER(productname) = LOWER($2) AND LOWER(brand) = LOWER($3)`,
          [godown_id, item.productname, item.brand || 'general']
        );

        let stockId;
        if (existStock.rows.length > 0) {
          stockId = existStock.rows[0].id;
          await client.query(
            `UPDATE public.stock SET current_cases = $1, date_added = CURRENT_TIMESTAMP, brand_id = $2 WHERE id = $3`,
            [existStock.rows[0].current_cases + item.cases, brand_id, stockId]
          );
        } else {
          const sIns = await client.query(
            `INSERT INTO public.stock (godown_id, product_type, productname, brand, brand_id, current_cases, per_case, date_added)
             VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP) RETURNING id`,
            [godown_id, productType, item.productname, item.brand || 'general', brand_id, item.cases, item.per_case]
          );
          stockId = sIns.rows[0].id;
        }

        // Ensure stock_history has needed columns
        await client.query(`
          CREATE TABLE IF NOT EXISTS public.stock_history (
            id BIGSERIAL PRIMARY KEY,
            stock_id INTEGER REFERENCES public.stock(id) ON DELETE CASCADE,
            action VARCHAR(10) CHECK (action IN ('added', 'taken')),
            cases INTEGER NOT NULL,
            per_case_total INTEGER NOT NULL,
            added_by TEXT,
            customer_name TEXT,
            date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);
        await client.query(`ALTER TABLE public.stock_history ADD COLUMN IF NOT EXISTS added_by TEXT`);
        await client.query(`ALTER TABLE public.stock_history ADD COLUMN IF NOT EXISTS customer_name TEXT`);

        await client.query(
          `INSERT INTO public.stock_history (stock_id, action, cases, per_case_total, added_by, customer_name, date)
           VALUES ($1, 'added', $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
          [stockId, item.cases, item.cases * item.per_case, performed_by || 'System', `PURCHASE: ${purchase_number}`]
        );

        // Log in purchase_dispatch_logs
        await client.query(
          `INSERT INTO public.purchase_dispatch_logs
           (purchase_id, product_index, product_name, brand, dispatched_cases, dispatched_qty, godown, allocated_by, dispatched_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)`,
          [purchase_id, idx, item.productname, item.brand || '', item.cases, item.quantity, godownRaw, performed_by || 'System']
        );

        allocationSummary.push({ product: item.productname, godown: godownRaw, cases: item.cases });
        await client.query('RELEASE SAVEPOINT sp_godown_alloc');
      } catch (allocErr) {
        await client.query('ROLLBACK TO SAVEPOINT sp_godown_alloc');
        console.log(`Auto-allocation skipped for item ${item.productname}:`, allocErr.message);
      }
    }

    const pdfBuffer = await generatePurchasePDFBuffer({
      purchase_number,
      purchase_date,
      supplier_name,
      address,
      gstin,
      invoice_number,
      agent_name,
      from: fromLoc,
      to: toLoc,
      through,
      items: processedItems,
      subtotal,
      packingCharges,
      packing_percent,
      addlDiscountAmt: discountAmtTotal,
      extraTaxable,
      taxableAmount: netTaxable,
      cgstAmt: cgst,
      sgstAmt: sgst,
      igstAmt: igst,
      roundOff,
      grandTotal,
      totalCases,
    });

    const pdfBase64 = pdfBuffer.toString('base64');
    await client.query('COMMIT');

    res.json({
      success: true,
      purchase_number,
      grandTotal,
      pdfBase64: `data:application/pdf;base64,${pdfBase64}`,
      allocationSummary
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create Purchase Error:', err.stack || err.message);
    res.status(500).json({ success: false, message: err.message || 'Failed to create purchase' });
  } finally {
    client.release();
  }
};

// ─── Get All Purchases ────────────────────────────────────────────────────────
exports.getPurchases = async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        p.*,
        COALESCE(SUM(pp.amount_paid), 0)::NUMERIC AS paid,
        (p.total - COALESCE(SUM(pp.amount_paid), 0))::NUMERIC AS balance,
        (
          SELECT json_agg(
            json_build_object(
              'id', pp2.id,
              'amount_paid', pp2.amount_paid,
              'payment_method', pp2.payment_method,
              'bank_name', pp2.bank_name,
              'transaction_date', pp2.transaction_date
            ) ORDER BY pp2.transaction_date
          )
          FROM purchase_payments pp2
          WHERE pp2.purchase_id = p.id
        ) AS payments
      FROM public.purchases p
      LEFT JOIN public.purchase_payments pp ON pp.purchase_id = p.id
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `);

    const result = rows.map(r => ({
      ...r,
      total: parseFloat(r.total) || 0,
      paid: parseFloat(r.paid) || 0,
      balance: parseFloat(r.balance) || 0,
      items: typeof r.items === 'string' ? JSON.parse(r.items || '[]') : r.items || [],
      extra_charges: typeof r.extra_charges === 'string' ? JSON.parse(r.extra_charges) : r.extra_charges || {},
      payments: r.payments || [],
    }));

    res.json(result);
  } catch (err) {
    console.error('getPurchases error:', err);
    res.status(500).json({ error: err.message });
  }
};

// ─── Get Purchase By ID ───────────────────────────────────────────────────────
exports.getPurchaseById = async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM public.purchases WHERE id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Purchase not found' });
    const r = rows[0];
    res.json({
      ...r,
      items: typeof r.items === 'string' ? JSON.parse(r.items) : r.items || [],
      extra_charges: typeof r.extra_charges === 'string' ? JSON.parse(r.extra_charges) : r.extra_charges || {},
    });
  } catch (err) {
    console.error('getPurchaseById error:', err);
    res.status(500).json({ error: err.message });
  }
};

// ─── Edit Purchase ────────────────────────────────────────────────────────────
exports.editPurchase = async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    const {
      supplier_name,
      address,
      gstin,
      invoice_number,
      agent_name = 'DIRECT',
      from: fromLoc = 'SIVAKASI',
      to: toLoc = 'SIVAKASI',
      through,
      additional_discount = 0,
      packing_percent = 3.0,
      taxable_value,
      items = [],
      apply_processing_fee = false,
      apply_cgst = false,
      apply_sgst = false,
      apply_igst = false,
    } = req.body;

    await client.query('BEGIN');

    let subtotal = 0;
    let totalCases = 0;
    const processedItems = [];

    for (const [idx, item] of items.entries()) {
      const { productname, brand, cases, per_case, discount_percent = 0, godown, rate_per_box } = item;
      const qty = Number(cases) * Number(per_case);
      const amountBefore = qty * Number(rate_per_box);
      const discountAmt = amountBefore * (Number(discount_percent) / 100);
      const finalAmt = amountBefore - discountAmt;
      subtotal += finalAmt;
      totalCases += Number(cases);
      processedItems.push({
        s_no: idx + 1,
        productname: productname.trim(),
        brand: brand?.trim() || '',
        cases: Number(cases),
        per_case: Number(per_case),
        quantity: qty,
        rate_per_box: Number(rate_per_box),
        discount_percent: Number(discount_percent),
        amount: Number(finalAmt.toFixed(2)),
        godown: godown?.trim() || fromLoc,
      });
    }

    const packingCharges = apply_processing_fee ? subtotal * (packing_percent / 100) : 0;
    const extraTaxable = taxable_value ? Number(taxable_value) : 0;
    const taxableAmount = subtotal + packingCharges + extraTaxable;
    const discountAmtTotal = taxableAmount * (additional_discount / 100);
    const netTaxable = taxableAmount - discountAmtTotal;

    let cgst = 0, sgst = 0, igst = 0;
    if (apply_igst) igst = netTaxable * 0.18;
    else if (apply_cgst && apply_sgst) { cgst = netTaxable * 0.09; sgst = netTaxable * 0.09; }

    const totalTax = cgst + sgst + igst;
    const grandTotal = Math.round(netTaxable + totalTax);
    const roundOff = grandTotal - (netTaxable + totalTax);

    await client.query(
      `UPDATE public.purchases SET
        supplier_name = $1, address = $2, gstin = $3, invoice_number = $4, agent_name = $5,
        "from" = $6, "to" = $7, "through" = $8, items = $9, total = $10, extra_charges = $11
       WHERE id = $12`,
      [
        supplier_name, address || '', gstin || '', invoice_number || '', agent_name,
        fromLoc, toLoc, through || '',
        JSON.stringify(processedItems), grandTotal,
        JSON.stringify({ packing_percent, additional_discount, taxable_value: extraTaxable, apply_processing_fee, apply_cgst, apply_sgst, apply_igst }),
        id
      ]
    );

    const pdfBuffer = await generatePurchasePDFBuffer({
      purchase_number: 'UPDATED',
      purchase_date: new Date().toISOString().split('T')[0],
      supplier_name, address, gstin, invoice_number, agent_name,
      from: fromLoc, to: toLoc, through,
      items: processedItems, subtotal, packingCharges, packing_percent,
      addlDiscountAmt: discountAmtTotal, extraTaxable, taxableAmount: netTaxable,
      cgstAmt: cgst, sgstAmt: sgst, igstAmt: igst, roundOff, grandTotal, totalCases,
    });

    const pdfBase64 = pdfBuffer.toString('base64');
    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Purchase updated successfully',
      pdfBase64: `data:application/pdf;base64,${pdfBase64}`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('editPurchase error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to update purchase' });
  } finally {
    client.release();
  }
};

// ─── Delete Purchase ──────────────────────────────────────────────────────────
exports.deletePurchase = async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM public.purchases WHERE id = $1', [id]);
    res.json({ success: true, message: 'Purchase deleted' });
  } catch (err) {
    console.error('deletePurchase error:', err);
    res.status(500).json({ error: err.message });
  }
};

// ─── Get Purchase PDF ─────────────────────────────────────────────────────────
exports.getPurchasePDF = async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query('SELECT * FROM public.purchases WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const r = rows[0];
    const items = typeof r.items === 'string' ? JSON.parse(r.items) : r.items || [];
    const extra = typeof r.extra_charges === 'string' ? JSON.parse(r.extra_charges) : r.extra_charges || {};

    let subtotal = items.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
    const packing_percent = parseFloat(extra.packing_percent) || 3.0;
    const packingCharges = extra.apply_processing_fee ? subtotal * (packing_percent / 100) : 0;
    const extraTaxable = parseFloat(extra.taxable_value) || 0;
    const taxableAmount = subtotal + packingCharges + extraTaxable;
    const additional_discount = parseFloat(extra.additional_discount) || 0;
    const discountAmtTotal = taxableAmount * (additional_discount / 100);
    const netTaxable = taxableAmount - discountAmtTotal;
    let cgst = 0, sgst = 0, igst = 0;
    if (extra.apply_igst) igst = netTaxable * 0.18;
    else if (extra.apply_cgst && extra.apply_sgst) { cgst = netTaxable * 0.09; sgst = netTaxable * 0.09; }
    const grandTotal = Math.round(netTaxable + cgst + sgst + igst);
    const roundOff = grandTotal - (netTaxable + cgst + sgst + igst);
    const totalCases = items.reduce((s, i) => s + (parseInt(i.cases) || 0), 0);

    const pdfBuffer = await generatePurchasePDFBuffer({
      purchase_number: r.purchase_number,
      purchase_date: r.purchase_date,
      supplier_name: r.supplier_name,
      address: r.address,
      gstin: r.gstin,
      invoice_number: r.invoice_number,
      agent_name: r.agent_name,
      from: r.from,
      to: r.to,
      through: r.through,
      items,
      subtotal,
      packingCharges,
      packing_percent,
      addlDiscountAmt: discountAmtTotal,
      taxableAmount: netTaxable,
      cgstAmt: cgst,
      sgstAmt: sgst,
      igstAmt: igst,
      roundOff,
      grandTotal,
      totalCases,
    });

    const pdfBase64 = pdfBuffer.toString('base64');
    res.json({ pdfBase64: `data:application/pdf;base64,${pdfBase64}` });
  } catch (err) {
    console.error('getPurchasePDF error:', err);
    res.status(500).json({ error: err.message });
  }
};

// ─── Purchase Ledger (supplier-wise) ─────────────────────────────────────────
exports.getPurchaseLedger = async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        p.id,
        p.purchase_number,
        p.purchase_date,
        p.supplier_name,
        p.address,
        p.through,
        p.total,
        p.items,
        p.extra_charges,
        p.created_at,
        COALESCE(SUM(pp.amount_paid), 0)::NUMERIC AS paid,
        (p.total - COALESCE(SUM(pp.amount_paid), 0))::NUMERIC AS balance,
        (
          SELECT json_agg(
            json_build_object(
              'id', pp2.id,
              'amount_paid', pp2.amount_paid,
              'payment_method', pp2.payment_method,
              'bank_name', pp2.bank_name,
              'paid_to', pp2.paid_to,
              'transaction_date', pp2.transaction_date
            ) ORDER BY pp2.transaction_date
          )
          FROM purchase_payments pp2
          WHERE pp2.purchase_id = p.id
        ) AS payments,
        (
          SELECT json_agg(
            json_build_object(
              'product_index', dl.product_index,
              'product_name', dl.product_name,
              'dispatched_cases', dl.dispatched_cases,
              'dispatched_qty', dl.dispatched_qty,
              'godown', dl.godown,
              'transport_name', dl.transport_name,
              'lr_number', dl.lr_number,
              'dispatched_at', dl.dispatched_at
            ) ORDER BY dl.dispatched_at
          )
          FROM purchase_dispatch_logs dl
          WHERE dl.purchase_id = p.id
        ) AS dispatch_logs
      FROM public.purchases p
      LEFT JOIN public.purchase_payments pp ON pp.purchase_id = p.id
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `);

    const result = rows.map(r => ({
      ...r,
      total: parseFloat(r.total) || 0,
      paid: parseFloat(r.paid) || 0,
      balance: parseFloat(r.balance) || 0,
      items: typeof r.items === 'string' ? JSON.parse(r.items || '[]') : r.items || [],
      extra_charges: typeof r.extra_charges === 'string' ? JSON.parse(r.extra_charges) : r.extra_charges || {},
      payments: r.payments || [],
      dispatch_logs: r.dispatch_logs || [],
    }));

    res.json(result);
  } catch (err) {
    console.error('getPurchaseLedger error:', err);
    res.status(500).json({ error: err.message });
  }
};

// ─── Record Purchase Payment ──────────────────────────────────────────────────
exports.recordPurchasePayment = async (req, res) => {
  const { purchase_id, amount_paid, payment_method, transaction_date = new Date(), bank_name, paid_to, admin_id } = req.body;

  if (!purchase_id || !amount_paid || !payment_method) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    await pool.query(
      `INSERT INTO public.purchase_payments (purchase_id, amount_paid, payment_method, bank_name, paid_to, transaction_date, admin_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [purchase_id, amount_paid, payment_method, bank_name || null, paid_to || null, transaction_date, admin_id || null]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('recordPurchasePayment error:', err);
    res.status(500).json({ error: err.message });
  }
};

// ─── Get Pending Purchases ────────────────────────────────────────────────────
exports.getPurchasePending = async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        p.id,
        p.purchase_number,
        p.supplier_name,
        p.total,
        COALESCE(SUM(pp.amount_paid), 0)::NUMERIC AS paid,
        (p.total - COALESCE(SUM(pp.amount_paid), 0))::NUMERIC AS balance,
        p.purchase_date
      FROM public.purchases p
      LEFT JOIN public.purchase_payments pp ON pp.purchase_id = p.id
      GROUP BY p.id, p.purchase_number, p.supplier_name, p.total, p.purchase_date
      HAVING (p.total - COALESCE(SUM(pp.amount_paid), 0)) > 0
      ORDER BY p.purchase_date DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('getPurchasePending error:', err);
    res.status(500).json({ error: err.message });
  }
};

// ─── Create Purchase Dispatch & Fill Godown Stock ──────────────────────────────
exports.createPurchaseDispatch = async (req, res) => {
  const client = await pool.connect();
  try {
    const { purchase_id, dispatches, through, lr_number } = req.body;

    if (!purchase_id || !Array.isArray(dispatches) || dispatches.length === 0) {
      return res.status(400).json({ message: 'Invalid dispatch data' });
    }

    await client.query('BEGIN');

    for (const d of dispatches) {
      const pCases = parseInt(d.dispatched_cases) || 0;
      const pQty = parseInt(d.dispatched_qty) || 0;
      const godownName = d.godown || 'Main Location';
      const formattedGodownName = godownName.toLowerCase().replace(/\s+/g, '_');

      // 1. Log the purchase dispatch / goods receipt
      await client.query(
        `INSERT INTO public.purchase_dispatch_logs
         (purchase_id, product_index, product_name, brand, dispatched_cases, dispatched_qty,
          godown, transport_name, lr_number, dispatched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
        [
          purchase_id,
          d.product_index,
          d.product_name || 'Unknown',
          d.brand || 'General',
          pCases,
          pQty,
          godownName,
          through || 'Own Transport',
          lr_number || null
        ]
      );

      // 2. Resolve or auto-create Godown in public.godown
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.godown (
          id BIGSERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL UNIQUE
        )
      `);

      let godownResult = await client.query(
        'SELECT id FROM public.godown WHERE name = $1 OR name = $2',
        [formattedGodownName, godownName]
      );
      let godown_id;
      if (godownResult.rows.length === 0) {
        const newG = await client.query(
          'INSERT INTO public.godown (name) VALUES ($1) RETURNING id',
          [formattedGodownName]
        );
        godown_id = newG.rows[0].id;
      } else {
        godown_id = godownResult.rows[0].id;
      }

      // 3. Resolve Product Brand in public.brand
      const pName = d.product_name || 'Unknown';
      const bName = d.brand || 'General';
      const perCase = parseInt(d.per_case) || (pCases > 0 ? Math.round(pQty / pCases) : 1) || 1;
      const productType = (d.product_type || 'general').toLowerCase().replace(/\s+/g, '_');

      await client.query(`
        CREATE TABLE IF NOT EXISTS public.brand (
          id BIGSERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL UNIQUE,
          agent_name VARCHAR(100)
        )
      `);
      const formattedBrand = bName.toLowerCase().replace(/\s+/g, '_');
      let brandResult = await client.query('SELECT id FROM public.brand WHERE name = $1', [formattedBrand]);
      if (brandResult.rows.length === 0) {
        brandResult = await client.query(
          'INSERT INTO public.brand (name) VALUES ($1) RETURNING id',
          [formattedBrand]
        );
      }
      const brand_id = brandResult.rows[0].id;

      // 4. Ensure public.stock table exists
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.stock (
          id BIGSERIAL PRIMARY KEY,
          godown_id INTEGER REFERENCES public.godown(id) ON DELETE CASCADE,
          product_type VARCHAR(100) NOT NULL,
          productname VARCHAR(255) NOT NULL,
          brand VARCHAR(100) NOT NULL,
          current_cases INTEGER NOT NULL DEFAULT 0,
          per_case INTEGER NOT NULL,
          date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_taken_date TIMESTAMP NULL,
          taken_cases INTEGER DEFAULT 0,
          brand_id INTEGER REFERENCES public.brand(id)
        )
      `);

      // 5. Update or Insert into public.stock
      const existingStock = await client.query(
        'SELECT id, current_cases FROM public.stock WHERE godown_id = $1 AND LOWER(productname) = LOWER($2) AND LOWER(brand) = LOWER($3)',
        [godown_id, pName, bName]
      );

      let stockId;
      if (existingStock.rows.length > 0) {
        stockId = existingStock.rows[0].id;
        const newCases = existingStock.rows[0].current_cases + pCases;
        await client.query(
          'UPDATE public.stock SET current_cases = $1, date_added = CURRENT_TIMESTAMP, brand_id = $2 WHERE id = $3',
          [newCases, brand_id, stockId]
        );
      } else {
        const newStock = await client.query(
          `INSERT INTO public.stock (godown_id, product_type, productname, brand, brand_id, current_cases, per_case, date_added)
           VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP) RETURNING id`,
          [godown_id, productType, pName, bName, brand_id, pCases, perCase]
        );
        stockId = newStock.rows[0].id;
      }

      // 6. Log entry in public.stock_history
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.stock_history (
          id BIGSERIAL PRIMARY KEY,
          stock_id INTEGER REFERENCES public.stock(id) ON DELETE CASCADE,
          action VARCHAR(10) CHECK (action IN ('added', 'taken')),
          cases INTEGER NOT NULL,
          per_case_total INTEGER NOT NULL,
          date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await client.query(
        `INSERT INTO public.stock_history (stock_id, action, cases, per_case_total, date)
         VALUES ($1, 'added', $2, $3, NOW())`,
        [stockId, pCases, pCases * perCase]
      );
    }

    await client.query('COMMIT');
    res.json({ message: 'Purchase received & stock filled in godown successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('createPurchaseDispatch error:', err);
    res.status(500).json({ message: err.message || 'Dispatch failed' });
  } finally {
    client.release();
  }
};

// ─── Get All Purchase Dispatch Logs ──────────────────────────────────────────
exports.getAllPurchaseDispatchLogs = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        dl.purchase_id,
        dl.product_index,
        dl.dispatched_cases,
        dl.dispatched_qty,
        dl.brand,
        dl.godown,
        dl.transport_name,
        dl.lr_number,
        dl.dispatched_at
      FROM public.purchase_dispatch_logs dl
      ORDER BY dl.dispatched_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('getAllPurchaseDispatchLogs error:', err);
    res.status(500).json({ message: 'Failed to fetch logs' });
  }
};

// ─── Get Dispatch Logs by Purchase ───────────────────────────────────────────
exports.getPurchaseDispatchLogs = async (req, res) => {
  const { purchase_id } = req.params;
  try {
    const { rows } = await pool.query(`
      SELECT * FROM public.purchase_dispatch_logs
      WHERE purchase_id = $1
      ORDER BY dispatched_at DESC
    `, [purchase_id]);
    res.json({ dispatch_logs: rows });
  } catch (err) {
    console.error('getPurchaseDispatchLogs error:', err);
    res.status(500).json({ message: 'Failed to fetch logs' });
  }
};

// ─── Get Unique Suppliers (for Select Party dropdown) ─────────────────────────
exports.getSuppliers = async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (supplier_name)
        supplier_name, address, gstin, agent_name, "from", "to", "through"
      FROM public.purchases
      ORDER BY supplier_name, created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('getSuppliers error:', err);
    res.status(500).json({ error: err.message });
  }
};

// ─── Get Bills by Supplier (for supplier-level tally) ────────────────────────
exports.getSupplierBills = async (req, res) => {
  try {
    const { supplier } = req.query;
    let whereClause = '';
    const params = [];
    if (supplier) {
      params.push(supplier);
      whereClause = `WHERE LOWER(p.supplier_name) = LOWER($1)`;
    }

    const { rows } = await pool.query(`
      SELECT
        p.id,
        p.purchase_number,
        p.purchase_date,
        p.supplier_name,
        p.address,
        p.is_closed,
        p.items,
        p.extra_charges,
        p.total,
        COALESCE(SUM(pp.amount_paid), 0)::NUMERIC AS paid,
        (p.total - COALESCE(SUM(pp.amount_paid), 0))::NUMERIC AS balance
      FROM public.purchases p
      LEFT JOIN public.purchase_payments pp ON pp.purchase_id = p.id
      ${whereClause}
      GROUP BY p.id
      ORDER BY p.supplier_name, p.purchase_date DESC
    `, params);

    // Compute cases and tax per bill
    const result = rows.map(r => {
      const items = typeof r.items === 'string' ? JSON.parse(r.items || '[]') : r.items || [];
      const extra = typeof r.extra_charges === 'string' ? JSON.parse(r.extra_charges) : r.extra_charges || {};
      const totalCases = items.reduce((s, i) => s + (parseInt(i.cases) || 0), 0);

      // Recompute tax from stored extra_charges
      let subtotal = items.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
      const packing_percent = parseFloat(extra.packing_percent) || 3.0;
      const packingCharges = extra.apply_processing_fee ? subtotal * (packing_percent / 100) : 0;
      const extraTaxable = parseFloat(extra.taxable_value) || 0;
      const taxableAmount = subtotal + packingCharges + extraTaxable;
      const additional_discount = parseFloat(extra.additional_discount) || 0;
      const discountAmt = taxableAmount * (additional_discount / 100);
      const netTaxable = taxableAmount - discountAmt;
      let cgst = 0, sgst = 0, igst = 0;
      if (extra.apply_igst) igst = netTaxable * 0.18;
      else if (extra.apply_cgst && extra.apply_sgst) { cgst = netTaxable * 0.09; sgst = netTaxable * 0.09; }
      const taxAmount = parseFloat((cgst + sgst + igst).toFixed(2));

      return {
        id: r.id,
        purchase_number: r.purchase_number,
        purchase_date: r.purchase_date,
        supplier_name: r.supplier_name,
        address: r.address,
        is_closed: r.is_closed,
        total: parseFloat(r.total) || 0,
        paid: parseFloat(r.paid) || 0,
        balance: parseFloat(r.balance) || 0,
        total_cases: totalCases,
        tax_amount: taxAmount,
      };
    });

    // If no supplier filter, group by supplier
    if (!supplier) {
      const grouped = {};
      result.forEach(bill => {
        if (!grouped[bill.supplier_name]) {
          grouped[bill.supplier_name] = {
            supplier_name: bill.supplier_name,
            address: bill.address,
            total_bills: 0,
            open_bills: 0,
            total_billed: 0,
            total_paid: 0,
            total_balance: 0,
          };
        }
        const g = grouped[bill.supplier_name];
        g.total_bills += 1;
        if (!bill.is_closed) g.open_bills += 1;
        g.total_billed += bill.total;
        g.total_paid += bill.paid;
        g.total_balance += bill.is_closed ? 0 : bill.balance;
      });
      return res.json(Object.values(grouped));
    }

    res.json(result);
  } catch (err) {
    console.error('getSupplierBills error:', err);
    res.status(500).json({ error: err.message });
  }
};

// ─── Close / Reopen a Purchase Bill (Admin action) ────────────────────────────
exports.closePurchaseBill = async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `UPDATE public.purchases SET is_closed = NOT is_closed WHERE id = $1 RETURNING is_closed`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Bill not found' });
    res.json({ success: true, is_closed: rows[0].is_closed });
  } catch (err) {
    console.error('closePurchaseBill error:', err);
    res.status(500).json({ error: err.message });
  }
};
