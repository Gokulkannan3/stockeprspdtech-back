const { Pool } = require('pg');
const PDFDocument = require('pdfkit');
const { getNextSequenceNumber } = require('../utils/sequence');

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

const formatDate = (dateInput) => {
  if (!dateInput) return '—';

  let date;

  if (typeof dateInput === 'string') {
    // Assume YYYY-MM-DD format
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
      const [y, m, d] = dateInput.split('-');
      return `${d}/${m}/${y}`;
    }
    // Try parsing anyway
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

const generatePDFBuffer = (data) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const safeNum = (val) => (parseFloat(val) || 0).toFixed(2);
    const safeStr = (val) => (val || '').toString();

    const bill_number = safeStr(data.bill_number || 'N/A');
    const bill_date = data.bill_date || null;
    const customer_name = safeStr(data.customer_name || 'N/A');
    const address = safeStr(data.address || '');
    const gstin = safeStr(data.gstin || '');
    const lr_number = safeStr(data.lr_number || '');
    const agent_name = safeStr(data.agent_name || 'DIRECT');
    const from = safeStr(data.from || 'SIVAKASI');
    const to = safeStr(data.to || '—');
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
    doc.fontSize(20).font('Helvetica-Bold').fillColor('#0f172a').text('SALES INVOICE / ESTIMATE', { align: 'center' });
    doc.fontSize(9).font('Helvetica').fillColor('#64748b').text('OFFICIAL BILLING STATEMENT', { align: 'center' }).moveDown(0.5);
    doc.moveTo(40, doc.y).lineTo(555, doc.y).lineWidth(1).strokeColor('#cbd5e1').stroke().moveDown(0.8);

    const leftX = 40;
    const rightX = 305;
    const startY = doc.y;

    // Customer Info Box
    doc.rect(leftX, startY, 250, 70).fillColor('#f8fafc').fill().strokeColor('#cbd5e1').stroke();
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#64748b').text('CUSTOMER / PARTY DETAILS', leftX + 10, startY + 8);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a').text(customer_name, leftX + 10, startY + 20);
    doc.font('Helvetica').fontSize(9).fillColor('#334155').text(`Address: ${address || '—'}`, leftX + 10, startY + 35);
    if (gstin) doc.font('Helvetica').fontSize(9).fillColor('#334155').text(`GSTIN: ${gstin}`, leftX + 10, startY + 48);

    // Bill Info Box
    doc.rect(rightX, startY, 250, 70).fillColor('#f8fafc').fill().strokeColor('#cbd5e1').stroke();
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#64748b').text('BILL & DISPATCH DETAILS', rightX + 10, startY + 8);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a').text(`Bill No: ${bill_number}`, rightX + 10, startY + 20);
    doc.font('Helvetica').fontSize(9).fillColor('#334155').text(`Date: ${formatDate(bill_date)}`, rightX + 10, startY + 35);
    doc.font('Helvetica').fontSize(9).fillColor('#334155').text(`Agent: ${agent_name} | Cases: ${totalCases}`, rightX + 10, startY + 48);

    let y = startY + 80;
    const tableStartX = 40;
    const tableWidth = 515;
    const colWidths = [35, 155, 45, 45, 55, 60, 65, 55];
    const rowHeight = 20;
    const cellPadding = 3;

    const headers = ['S.No', 'Product Name', 'Cases', 'Per', 'Qty', 'Rate', 'Amount', 'Godown'];
    const verticalLines = [tableStartX];
    colWidths.forEach(w => verticalLines.push(verticalLines[verticalLines.length - 1] + w));

    // Table Header
    const headerTop = y;
    const headerBottom = y + rowHeight;
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
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#64748b').text('TRANSPORT DETAILS', 50, transportStartY + 8);
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
      ['SUB TOTAL', subtotal],
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
      .text('NET GRAND TOTAL', labelX + 8, netY + 4)
      .text(`₹${grandTotal.toFixed(2)}`, valueX, netY + 4, { width: valueWidth - 8, align: 'right' });

    // Footer & Signature
    const footerY = Math.max(y, ty) + 40;
    doc.font('Helvetica').fontSize(8).fillColor('#64748b');
    doc.text('Note: 1. Goods once sold will not be taken back. 2. Subject to Sivakasi Jurisdiction.', 40, footerY);

    const sigY = footerY + 20;
    doc.text('Authorised Signatory', 420, sigY + 25);
    doc.moveTo(420, sigY + 20).lineTo(555, sigY + 20).strokeColor('#94a3b8').stroke();

    doc.end();
  });
};

exports.createBooking = async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      customer_name,
      address,
      gstin,
      lr_number,
      agent_name = 'DIRECT',
      from: fromLoc = 'SIVAKASI',
      to: toLoc,
      through,
      additional_discount = 0,
      packing_percent = 3.0,
      taxable_value,
      stock_from,
      items = [],
      apply_processing_fee = false,
      apply_cgst = false,
      apply_sgst = false,
      apply_igst = false,
      from_challan = false,
      challan_id,
      is_direct_bill = false,
      performed_by,   // ← NEW: username sent from frontend
    } = req.body;

    if (!customer_name || !items.length || !toLoc || !through) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    await client.query('BEGIN');

    let finalItems = items;
    let finalCustomerName = customer_name;
    let finalAddress = address || '';
    let finalGstin = gstin || '';
    let finalLrNumber = lr_number || '';
    let finalFrom = fromLoc;
    let finalTo = toLoc;
    let finalThrough = through;

    // If from challan: load base data from delivery, override with payload
    if (from_challan && challan_id) {
      const challanRes = await client.query(
        `SELECT * FROM delivery WHERE id = $1 AND converted_to_bill = FALSE`,
        [challan_id]
      );

      if (challanRes.rows.length === 0) {
        throw new Error('Challan not found or already converted');
      }

      const challan = challanRes.rows[0];

      finalCustomerName = customer_name || challan.customer_name || '';
      finalAddress = address || challan.address || '';
      finalGstin = gstin || challan.gstin || '';
      finalLrNumber = lr_number || challan.lr_number || '';
      finalFrom = fromLoc || challan.from || 'SIVAKASI';
      finalTo = toLoc || challan.to || '';
      finalThrough = through || challan.through || '';

      finalItems = items.length > 0 ? items : (typeof challan.items === 'string' ? JSON.parse(challan.items) : challan.items || []);

      await client.query('UPDATE delivery SET converted_to_bill = TRUE WHERE id = $1', [challan_id]);
    }

    if (finalItems.length === 0) {
      throw new Error('No items available');
    }

    const sequenceNumber = await getNextSequenceNumber();
    const bill_number = `BILL-${sequenceNumber}`;
    const bill_date = new Date().toISOString().split('T')[0];

    let subtotal = 0;
    let totalCases = 0;
    const processedItems = [];

    for (const [idx, item] of finalItems.entries()) {
      const {
        id: stock_id,
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

      // Deduct stock only for direct bills (not from challan — already deducted)
      if (!from_challan) {
        const stockRes = await client.query(
          'SELECT current_cases FROM public.stock WHERE id = $1 FOR UPDATE',
          [stock_id]
        );
        if (stockRes.rows.length === 0 || cases > stockRes.rows[0].current_cases) {
          throw new Error(`Insufficient stock for ${productname}`);
        }
        await client.query(
          'UPDATE public.stock SET current_cases = current_cases - $1, taken_cases = taken_cases + $1 WHERE id = $2',
          [cases, stock_id]
        );

        // ─── RECORD WHO TOOK THE STOCK ───────────────────────────────────────
        await client.query(
          `INSERT INTO public.stock_history 
             (stock_id, action, cases, per_case_total, date, customer_name, taken_by)
           VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5, $6)`,
          [
            stock_id,
            'taken',
            cases,
            cases * (per_case || 1),
            finalCustomerName || 'Walk-in',
            performed_by || 'Unknown'   // ← username from frontend (or fallback)
          ]
        );
        // ──────────────────────────────────────────────────────────────────────
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
        product_type: item.product_type?.trim() || '',
        cases: Number(cases),
        per_case: Number(per_case),
        quantity: qty,
        rate_per_box: Number(rate_per_box),
        discount_percent: Number(discount_percent),
        amount: Number(finalAmt.toFixed(2)),
        godown: godown?.trim() || stock_from || finalFrom,
      });
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

    await client.query(
      `INSERT INTO public.bookings (
        bill_number, bill_date, customer_name, address, gstin, lr_number, agent_name,
        "from", "to", "through", stock_from, items, total, extra_charges, from_challan
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        bill_number, bill_date, finalCustomerName, finalAddress, finalGstin, finalLrNumber,
        agent_name, finalFrom, finalTo, finalThrough, stock_from || finalFrom,
        JSON.stringify(processedItems), grandTotal,
        JSON.stringify({
          packing_percent, additional_discount, taxable_value: extraTaxable,
          apply_processing_fee, apply_cgst, apply_sgst, apply_igst, is_direct_bill, from_challan
        }),
        from_challan
      ]
    );

    const pdfBuffer = await generatePDFBuffer({
      bill_number,
      bill_date,
      customer_name: finalCustomerName,
      address: finalAddress,
      gstin: finalGstin,
      lr_number: finalLrNumber,
      agent_name,
      from: finalFrom,
      to: finalTo,
      through: finalThrough,
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
      bill_number,
      grandTotal,
      pdfBase64: `data:application/pdf;base64,${pdfBase64}`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create Booking Error:', err.stack || err.message);
    res.status(500).json({ success: false, message: err.message || 'Failed to create bill' });
  } finally {
    client.release();
  }
};

exports.getBookingPDF = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(`
      SELECT 
        bill_number, bill_date, customer_name, address, gstin, lr_number, agent_name,
        "from", "to", "through", items, extra_charges
      FROM public.bookings 
      WHERE id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Bill not found' });
    }

    const booking = result.rows[0];

    // SAFE PARSING - handles both string and object
    const items = typeof booking.items === 'string'
      ? JSON.parse(booking.items || '[]')
      : (Array.isArray(booking.items) ? booking.items : []);

    const extra = typeof booking.extra_charges === 'string'
      ? JSON.parse(booking.extra_charges || '{}')
      : (booking.extra_charges || {});

    let subtotal = 0;
    let totalCases = 0;

    items.forEach(item => {
      const qty = (item.cases || 0) * (item.per_case || 1);
      const rate = parseFloat(item.rate_per_box) || 0;
      const discount = (item.discount_percent || 0) / 100;
      const amt = qty * rate * (1 - discount);
      subtotal += amt;
      totalCases += (item.cases || 0);
    });

    const packingCharges = extra.apply_processing_fee ? subtotal * (extra.packing_percent || 3) / 100 : 0;
    const taxableAmount = subtotal + packingCharges + (extra.taxable_value || 0);
    const discountAmt = taxableAmount * ((extra.additional_discount || 0) / 100);
    const netTaxable = taxableAmount - discountAmt;

    let cgst = 0, sgst = 0, igst = 0;
    if (extra.apply_igst) {
      igst = netTaxable * 0.18;
    } else if (extra.apply_cgst && extra.apply_sgst) {
      cgst = netTaxable * 0.09;
      sgst = netTaxable * 0.09;
    }

    const totalTax = cgst + sgst + igst;
    const grandTotal = Math.round(netTaxable + totalTax);
    const roundOff = grandTotal - (netTaxable + totalTax);

    const pdfBuffer = await generatePDFBuffer({
      bill_number: booking.bill_number,
      bill_date: booking.bill_date,
      customer_name: booking.customer_name,
      address: booking.address || '',
      gstin: booking.gstin || '',
      lr_number: booking.lr_number || '',
      agent_name: booking.agent_name || 'DIRECT',
      from: booking.from || 'SIVAKASI',
      to: booking.to,
      through: booking.through || '',
      items,
      subtotal: parseFloat(subtotal.toFixed(2)),
      packingCharges: parseFloat(packingCharges.toFixed(2)),
      subtotalWithPacking: parseFloat((subtotal + packingCharges).toFixed(2)),
      taxableUsed: parseFloat(taxableAmount.toFixed(2)),
      addlDiscountAmt: parseFloat(discountAmt.toFixed(2)),
      roundOff: parseFloat(roundOff.toFixed(2)),
      grandTotal,
      totalCases,
      stock_from: booking.from || 'SIVAKASI',
      packing_percent: extra.packing_percent || 3.0,
      cgstAmt: parseFloat(cgst.toFixed(2)),
      sgstAmt: parseFloat(sgst.toFixed(2)),
      igstAmt: parseFloat(igst.toFixed(2))
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${booking.bill_number}.pdf"`);
    res.send(pdfBuffer);

  } catch (err) {
    console.error('PDF Generation Error:', err);
    res.status(500).json({ message: 'Failed to generate PDF: ' + err.message });
  }
};

exports.getBookings = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id, bill_number, bill_date, customer_name, address, gstin,
        "from", "to", through, lr_number,
        items, created_at
      FROM public.bookings 
      ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch bookings' });
  }
};

exports.getCustomers = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (customer_name)
        customer_name, address, gstin, lr_number, agent_name, "from", "to", "through"
      FROM public.bookings
      WHERE customer_name IS NOT NULL AND customer_name != ''
      ORDER BY customer_name, created_at DESC
    `);

    const customers = result.rows.map(row => ({
      label: row.customer_name,
      value: {
        name: row.customer_name,
        address: row.address || '',
        gstin: row.gstin || '',
        lr_number: row.lr_number || '',
        agent_name: row.agent_name || '',
        from: row.from || '',
        to: row.to || '',
        through: row.through || ''
      }
    }));

    res.json(customers);
  } catch (err) {
    console.error('Get Customers Error:', err);
    res.status(500).json({ message: 'Failed to fetch customers' });
  }
};

exports.searchProductsGlobal = async (req, res) => {
  const { name } = req.query;
  const searchTerm = `%${name.trim().toLowerCase()}%`;

  try {
    // Get all godowns
    const godownsRes = await pool.query(`SELECT id, name FROM public.godown`);
    const godowns = godownsRes.rows;

    const allResults = [];

    for (const godown of godowns) {
      const godownId = godown.id;

      // Get product types in this godown
      const typesRes = await pool.query(`
        SELECT DISTINCT product_type
        FROM public.stock 
        WHERE godown_id = $1 AND current_cases > 0
          AND (LOWER(productname) LIKE $2 OR LOWER(brand) LIKE $2)
      `, [godownId, searchTerm]);

      if (typesRes.rows.length === 0) continue;

      const productTypes = typesRes.rows.map(r => r.product_type);
      let joins = '';
      const params = [godownId, searchTerm];
      let idx = 3;

      productTypes.forEach(type => {
        const table = type.toLowerCase().replace(/\s+/g, '_');
        joins += `
          LEFT JOIN public."${table}" p${idx}
            ON LOWER(s.productname) = LOWER(p${idx}.productname)
            AND LOWER(s.brand) = LOWER(p${idx}.brand)
        `;
        idx++;
      });

      const finalQuery = `
        SELECT 
          s.id,
          s.product_type,
          s.productname,
          s.brand,
          s.per_case,
          s.current_cases,
          COALESCE(
            ${productTypes.map((_, i) => `CAST(p${i + 3}.price AS NUMERIC)`).join(', ')}, 
            0
          )::NUMERIC AS rate_per_box,
          $1::INTEGER AS godown_id,
          '${godown.name}' AS godown_name
        FROM public.stock s
        ${joins}
        WHERE s.godown_id = $1 
          AND s.current_cases > 0
          AND (LOWER(s.productname) LIKE $2 OR LOWER(s.brand) LIKE $2)
        ORDER BY s.product_type, s.productname
      `;

      const result = await pool.query(finalQuery, params);
      allResults.push(...result.rows);
    }

    res.json(allResults);
  } catch (err) {
    console.error('searchProductsGlobal:', err.message);
    res.status(500).json({ message: 'Search failed' });
  }
};

exports.editBooking = async (req, res) => {
  const client = await pool.connect();
  const { id } = req.params;
  const {
    customer_name,
    address = '',
    gstin = '',
    lr_number = '',
    agent_name = '',
    from: fromLoc,
    to: toLoc,
    through = '',
    additional_discount = 0,
    packing_percent = 3.0,
    taxable_value,
    stock_from = '',
    items = []
  } = req.body;

  try {
    await client.query('BEGIN');

    // 1. Get original booking
    const origRes = await client.query(
      'SELECT items, pdf_path FROM public.bookings WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (origRes.rows.length === 0) throw new Error('Booking not found');
    const original = origRes.rows[0];

    const oldItems = Array.isArray(original.items) ? original.items : [];

    // 2. Restock old items
    for (const item of oldItems) {
      const { id: stock_id, cases } = item;
      if (!stock_id || !cases) continue;

      await client.query(
        'UPDATE public.stock SET current_cases = current_cases + $1, taken_cases = taken_cases - $1 WHERE id = $2',
        [cases, stock_id]
      );
      await client.query(
        `INSERT INTO public.stock_history (stock_id, action, cases, per_case_total, date, customer_name) 
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5)`,
        [stock_id, 'added', cases, cases * (item.per_case || 1), customer_name]
      );
    }

    // 3. Process new items (deduct stock)
    let subtotal = 0;
    let totalCases = 0;
    const processedItems = [];

    for (const [idx, item] of items.entries()) {
      const {
        id: stock_id,
        productname,
        brand,
        cases,
        per_case,
        discount_percent = 0,
        godown,
        rate_per_box
      } = item;

      if (!stock_id || !cases || !per_case || rate_per_box === undefined) {
        throw new Error(`Invalid item at index ${idx}`);
      }

      const stockCheck = await client.query(
        'SELECT current_cases FROM public.stock WHERE id = $1 FOR UPDATE',
        [stock_id]
      );
      if (stockCheck.rows.length === 0) throw new Error(`Stock not found: ${stock_id}`);
      if (cases > stockCheck.rows[0].current_cases) {
        throw new Error(`Not enough stock: ${productname}`);
      }

      const qty = cases * per_case;
      const amountBefore = qty * rate_per_box;
      const discountAmt = amountBefore * (discount_percent / 100);
      const finalAmt = amountBefore - discountAmt;

      subtotal += finalAmt;
      totalCases += cases;

      // Deduct stock
      await client.query(
        'UPDATE public.stock SET current_cases = current_cases - $1, taken_cases = taken_cases + $1, last_taken_date = CURRENT_TIMESTAMP WHERE id = $2',
        [cases, stock_id]
      );
      await client.query(
        `INSERT INTO public.stock_history (stock_id, action, cases, per_case_total, date, customer_name) 
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5)`,
        [stock_id, 'taken', cases, qty, customer_name]
      );

      processedItems.push({
        s_no: idx + 1,
        productname: productname || '',
        brand: brand || '',
        cases: Number(cases),
        per_case: Number(per_case),
        quantity: Number(qty),
        rate_per_box: parseFloat(rate_per_box),
        discount_percent: parseFloat(discount_percent),
        amount: parseFloat(finalAmt.toFixed(2)),
        godown: godown || stock_from
      });
    }

    // 4. Recalculate totals
    const packingCharges = subtotal * (packing_percent / 100);
    const subtotalWithPacking = subtotal + packingCharges;
    const taxableUsed = taxable_value ? parseFloat(taxable_value) : subtotalWithPacking;
    const addlDiscountAmt = taxableUsed * (additional_discount / 100);
    const netBeforeRound = taxableUsed - addlDiscountAmt;
    const grandTotal = Math.round(netBeforeRound);
    const roundOff = grandTotal - netBeforeRound;

    // 6. Update booking
    await client.query(
      `UPDATE public.bookings SET
        customer_name = $1, address = $2, gstin = $3, lr_number = $4, agent_name = $5,
        "from" = $6, "to" = $7, "through" = $8, additional_discount = $9,
        packing_percent = $10, taxable_value = $11, stock_from = $12,
        items = $13, updated_at = CURRENT_TIMESTAMP
      WHERE id = $14`,
      [
        customer_name,
        address,
        gstin,
        lr_number,
        agent_name,
        fromLoc,
        toLoc,
        through,
        additional_discount,
        packing_percent,
        taxable_value ? parseFloat(taxable_value) : null,
        stock_from,
        JSON.stringify(processedItems),
        id
      ]
    );

    await client.query('COMMIT');
    res.json({
      success: true,
      message: 'Booking updated successfully'
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Edit Booking Error:', err.message);
    res.status(500).json({ message: err.message });
  } finally {
    client.release();
  }
};

exports.deleteBooking = async (req, res) => {
  const client = await pool.connect();
  const { id } = req.params;

  try {
    await client.query('BEGIN');

    const bookingRes = await client.query(
      'SELECT id, bill_number, items, customer_name FROM public.bookings WHERE id = $1 FOR UPDATE',
      [id]
    );

    if (bookingRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Bill not found' });
    }

    const booking = bookingRes.rows[0];
    const billNumber = booking.bill_number || `ID-${id}`;
    const customerName = booking.customer_name || 'DELETED';
    const itemsRaw = booking.items;

    let parsedItems = [];
    let restockCount = 0;
    let skippedCount = 0;

    if (itemsRaw) {
      try {
        const parsed = typeof itemsRaw === 'string' ? JSON.parse(itemsRaw) : itemsRaw;
        if (Array.isArray(parsed)) {
          parsedItems = parsed;
        }
      } catch (e) {
        console.error('Parse failed during delete:', e.message);
      }
    }

    // Load godowns and create lookup map
    const godownsRes = await client.query('SELECT id, name FROM public.godown');
    const godownMap = {};
    godownsRes.rows.forEach(g => {
      godownMap[g.name.toUpperCase()] = g.id;
      // Also support short codes / initials if you want
    });

    // Restock loop with history recording
    for (const item of parsedItems) {
      let { godown, cases, productname, id: stock_id } = item;

      if (!cases || cases <= 0 || !productname) {
        skippedCount++;
        continue;
      }

      godown = (godown || '').trim().toUpperCase();

      // Try to find godown_id — prefer exact match, fallback to any containing
      let godownId = godownMap[godown];
      if (!godownId) {
        const fallback = godownsRes.rows.find(g => g.name.toUpperCase().includes(godown));
        godownId = fallback?.id;
      }

      if (!godownId) {
        skippedCount++;
        console.log(`No godown matched for: ${godown}`);
        continue;
      }

      // Prefer exact stock_id if available from the booking items
      let targetStockId = stock_id;

      if (!targetStockId) {
        // Fallback: loose match by product name
        const stockRes = await client.query(
          `SELECT id FROM public.stock 
           WHERE godown_id = $1 AND productname ILIKE $2 
           LIMIT 1`,
          [godownId, `%${productname.split(' ')[0]}%`]
        );
        targetStockId = stockRes.rows[0]?.id;
      }

      if (!targetStockId) {
        skippedCount++;
        console.log(`No matching stock found for: ${productname} in godown ${godown}`);
        continue;
      }

      // Restock
      await client.query(
        `UPDATE public.stock 
         SET current_cases = current_cases + $1,
             taken_cases = GREATEST(taken_cases - $1, 0)
         WHERE id = $2`,
        [cases, targetStockId]
      );

      // Record who returned the stock (deleted the bill)
      await client.query(
        `INSERT INTO public.stock_history 
           (stock_id, action, cases, per_case_total, date, customer_name, added_by)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5, $6)`,
        [
          targetStockId,
          'added',
          cases,
          cases * (item.per_case || 1),
          customerName || 'DELETED BILL',
          'System-Delete'   // or pass from req.body.performed_by if you add it
        ]
      );

      restockCount++;
    }

    await client.query('DELETE FROM public.bookings WHERE id = $1', [id]);
    await client.query('COMMIT');

    res.json({
      success: true,
      message: `Bill ${billNumber} deleted successfully`,
      restocked: restockCount,
      skipped: skippedCount,
      details: restockCount > 0 ? 'Cases restored to stock' : 'No items could be restocked'
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DELETE BOOKING ERROR]', err.stack || err.message);
    res.status(500).json({ success: false, message: err.message || 'Failed to delete booking' });
  } finally {
    client.release();
  }
};

exports.getBookingById = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(`
      SELECT 
        *
      FROM public.bookings 
      WHERE id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Bill not found' });
    }

    const booking = result.rows[0];

    // Parse JSON fields safely
    booking.items = typeof booking.items === 'string' ? JSON.parse(booking.items || '[]') : booking.items || [];
    booking.extra_charges = typeof booking.extra_charges === 'string' ? JSON.parse(booking.extra_charges || '{}') : booking.extra_charges || {};

    res.json(booking);
  } catch (err) {
    console.error('Get Booking By ID Error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

exports.updateBooking = async (req, res) => {
  const client = await pool.connect();
  const { id } = req.params;

  try {
    await client.query('BEGIN');

    // Reuse the same logic as create, but update instead of insert
    const {
      customer_name,
      address,
      gstin,
      lr_number,
      agent_name = 'DIRECT',
      from: fromLoc = 'SIVAKASI',
      to: toLoc,
      through,
      additional_discount = 0,
      packing_percent = 3.0,
      taxable_value,
      stock_from,
      items = [],
      apply_processing_fee = false,
      apply_cgst = false,
      apply_sgst = false,
      apply_igst = false,
    } = req.body;

    if (!customer_name || !items.length || !toLoc || !through) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    let subtotal = 0;
    let totalCases = 0;
    const processedItems = [];

    for (const [idx, item] of items.entries()) {
      const {
        id: stock_id,
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
        godown: godown?.trim() || stock_from || fromLoc,
      });
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

    await client.query(
      `UPDATE public.bookings SET
        customer_name = $1, address = $2, gstin = $3, lr_number = $4, agent_name = $5,
        "from" = $6, "to" = $7, "through" = $8, stock_from = $9, items = $10,
        total = $11, extra_charges = $12
      WHERE id = $13`,
      [
        customer_name, address || '', gstin || '', lr_number || '',
        agent_name, fromLoc, toLoc, through, stock_from || fromLoc,
        JSON.stringify(processedItems), grandTotal,
        JSON.stringify({
          packing_percent, additional_discount, taxable_value: extraTaxable,
          apply_processing_fee, apply_cgst, apply_sgst, apply_igst
        }),
        id
      ]
    );

    const pdfBuffer = await generatePDFBuffer({
      bill_number: 'UPDATED', // you can fetch real bill_number if needed
      bill_date: new Date().toISOString().split('T')[0],
      customer_name,
      address,
      gstin,
      lr_number,
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
      message: 'Bill updated successfully',
      bill_number: 'UPDATED', // fetch real if needed
      pdfBase64: `data:application/pdf;base64,${pdfBase64}`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Update Booking Error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to update bill' });
  } finally {
    client.release();
  }
};