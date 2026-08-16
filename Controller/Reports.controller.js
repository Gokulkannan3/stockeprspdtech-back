const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
});

// ─── 1. Godown Stock Summary Report ──────────────────────────────────────────
exports.getGodownStockReport = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        g.id AS godown_id,
        g.name AS godown_name,
        s.id AS stock_id,
        s.productname,
        s.brand,
        s.product_type,
        s.current_cases,
        s.per_case,
        (s.current_cases * s.per_case) AS total_quantity,
        s.date_added,
        s.last_taken_date,
        COALESCE(b.agent_name, '-') AS agent_name
      FROM public.godown g
      LEFT JOIN public.stock s ON s.godown_id = g.id
      LEFT JOIN public.brand b ON s.brand = b.name
      ORDER BY g.name, s.productname
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('getGodownStockReport Error:', err);
    res.status(500).json({ error: err.message });
  }
};

// ─── 2. Purchase Report ──────────────────────────────────────────────────────
exports.getPurchaseReport = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let query = `
      SELECT 
        p.id,
        p.purchase_number,
        p.purchase_date,
        p.supplier_name,
        p.invoice_number,
        p.agent_name,
        p.from,
        p.to,
        p.through,
        p.items,
        p.total,
        p.is_closed,
        COALESCE(SUM(pp.amount_paid), 0)::NUMERIC AS paid,
        (p.total - COALESCE(SUM(pp.amount_paid), 0))::NUMERIC AS balance
      FROM public.purchases p
      LEFT JOIN public.purchase_payments pp ON pp.purchase_id = p.id
    `;
    const params = [];
    if (startDate && endDate) {
      params.push(startDate, endDate);
      query += ` WHERE p.purchase_date BETWEEN $1 AND $2`;
    }
    query += ` GROUP BY p.id ORDER BY p.purchase_date DESC, p.created_at DESC`;

    const { rows } = await pool.query(query, params);
    const result = rows.map(r => ({
      ...r,
      total: parseFloat(r.total) || 0,
      paid: parseFloat(r.paid) || 0,
      balance: parseFloat(r.balance) || 0,
      items: typeof r.items === 'string' ? JSON.parse(r.items || '[]') : r.items || [],
      total_cases: (typeof r.items === 'string' ? JSON.parse(r.items || '[]') : r.items || []).reduce((sum, item) => sum + (parseInt(item.cases) || 0), 0)
    }));
    res.json(result);
  } catch (err) {
    console.error('getPurchaseReport Error:', err);
    res.status(500).json({ error: err.message });
  }
};

// ─── 3. Transfer Logs & Challan Report ───────────────────────────────────────
exports.getTransferLogReport = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        tc.*,
        tc.created_at AS transferred_at
      FROM public.godown_transfer_challans tc
      ORDER BY tc.created_at DESC
    `);
    res.json(result.rows.map(r => ({
      ...r,
      product_details: typeof r.product_details === 'string' ? JSON.parse(r.product_details) : r.product_details || []
    })));
  } catch (err) {
    console.error('getTransferLogReport Error:', err);
    res.status(500).json({ error: err.message });
  }
};

// ─── 4. Supplier Outstanding Report ─────────────────────────────────────────
exports.getSupplierOutstandingReport = async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        p.supplier_name,
        p.address,
        p.gstin,
        COUNT(p.id) AS total_bills,
        SUM(CASE WHEN p.is_closed = FALSE AND (p.total - COALESCE(pp_sum.paid, 0)) > 0 THEN 1 ELSE 0 END) AS pending_bills,
        SUM(p.total) AS total_purchased_amount,
        COALESCE(SUM(pp_sum.paid), 0) AS total_paid_amount,
        SUM(CASE WHEN p.is_closed = FALSE THEN (p.total - COALESCE(pp_sum.paid, 0)) ELSE 0 END) AS net_outstanding_balance
      FROM public.purchases p
      LEFT JOIN (
        SELECT purchase_id, SUM(amount_paid) AS paid
        FROM public.purchase_payments
        GROUP BY purchase_id
      ) pp_sum ON pp_sum.purchase_id = p.id
      GROUP BY p.supplier_name, p.address, p.gstin
      ORDER BY net_outstanding_balance DESC, p.supplier_name
    `);
    res.json(rows);
  } catch (err) {
    console.error('getSupplierOutstandingReport Error:', err);
    res.status(500).json({ error: err.message });
  }
};

// ─── 5. Unique Customer/Dealer List ──────────────────────────────────────────
exports.getCustomerList = async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT customer_name, address, gstin
      FROM public.bookings
      WHERE customer_name IS NOT NULL AND TRIM(customer_name) != ''
      ORDER BY customer_name
    `);
    res.json(rows);
  } catch (err) {
    console.error('getCustomerList Error:', err);
    res.status(500).json({ error: err.message });
  }
};

// ─── 6. Dealer Abstract Report ──────────────────────────────────────────────
exports.getDealerAbstractReport = async (req, res) => {
  try {
    const { customer, startDate, endDate } = req.query;
    if (!customer) {
      return res.status(400).json({ error: 'Customer name is required' });
    }

    let query = `
      SELECT id, bill_number, bill_date, customer_name, address, items, total
      FROM public.bookings
      WHERE LOWER(customer_name) = LOWER($1)
    `;
    const params = [customer.trim()];

    if (startDate && endDate) {
      params.push(startDate, endDate);
      query += ` AND bill_date BETWEEN $2 AND $3`;
    }

    query += ` ORDER BY bill_date ASC`;

    const { rows: bills } = await pool.query(query, params);

    // Look up product types from stock table for missing types
    const stockTypeRes = await pool.query(
      `SELECT LOWER(productname) AS pname, LOWER(brand) AS bname, product_type FROM public.stock`
    );
    const stockTypeMap = {};
    stockTypeRes.rows.forEach(r => {
      stockTypeMap[`${r.pname}_${r.bname}`] = r.product_type;
      if (!stockTypeMap[r.pname]) stockTypeMap[r.pname] = r.product_type;
    });

    let grandTotalCases = 0;
    let grandTotalQty = 0;
    let grandTotalAmount = 0;

    // Structure: { categoryName: { brandName: { productName: { cases, per_case, total_qty, total_amount } } } }
    const categoriesMap = {};

    bills.forEach(bill => {
      const items = typeof bill.items === 'string' ? JSON.parse(bill.items || '[]') : bill.items || [];
      items.forEach(item => {
        const pName = (item.productname || 'Unknown Product').trim();
        const bName = (item.brand || 'General').trim();
        const pKey = `${pName.toLowerCase()}_${bName.toLowerCase()}`;
        
        let pType = item.product_type || stockTypeMap[pKey] || stockTypeMap[pName.toLowerCase()] || 'General Category';
        pType = pType.replace(/_/g, ' ').toUpperCase();

        const cases = parseInt(item.cases) || 0;
        const perCase = parseInt(item.per_case) || 1;
        const qty = cases * perCase;
        const amount = parseFloat(item.amount) || (qty * (parseFloat(item.rate_per_box) || 0));

        grandTotalCases += cases;
        grandTotalQty += qty;
        grandTotalAmount += amount;

        if (!categoriesMap[pType]) {
          categoriesMap[pType] = {
            categoryName: pType,
            categoryTotalCases: 0,
            categoryTotalQty: 0,
            categoryTotalAmount: 0,
            brands: {}
          };
        }

        const catObj = categoriesMap[pType];
        catObj.categoryTotalCases += cases;
        catObj.categoryTotalQty += qty;
        catObj.categoryTotalAmount += amount;

        if (!catObj.brands[bName]) {
          catObj.brands[bName] = {
            brandName: bName,
            brandTotalCases: 0,
            brandTotalQty: 0,
            brandTotalAmount: 0,
            products: {}
          };
        }

        const brandObj = catObj.brands[bName];
        brandObj.brandTotalCases += cases;
        brandObj.brandTotalQty += qty;
        brandObj.brandTotalAmount += amount;

        if (!brandObj.products[pName]) {
          brandObj.products[pName] = {
            productName: pName,
            brandName: bName,
            perCase: perCase,
            cases: 0,
            totalQty: 0,
            totalAmount: 0
          };
        }

        const prodObj = brandObj.products[pName];
        prodObj.cases += cases;
        prodObj.totalQty += qty;
        prodObj.totalAmount += amount;
      });
    });

    // Format structure to arrays for easy frontend rendering
    const categories = Object.values(categoriesMap).map(cat => ({
      categoryName: cat.categoryName,
      categoryTotalCases: cat.categoryTotalCases,
      categoryTotalQty: cat.categoryTotalQty,
      categoryTotalAmount: cat.categoryTotalAmount,
      brands: Object.values(cat.brands).map(br => ({
        brandName: br.brandName,
        brandTotalCases: br.brandTotalCases,
        brandTotalQty: br.brandTotalQty,
        brandTotalAmount: br.brandTotalAmount,
        products: Object.values(br.products)
      }))
    }));

    res.json({
      customer_name: customer,
      total_bills: bills.length,
      grandTotalCases,
      grandTotalQty,
      grandTotalAmount,
      categories
    });
  } catch (err) {
    console.error('getDealerAbstractReport Error:', err);
    res.status(500).json({ error: err.message });
  }
};
