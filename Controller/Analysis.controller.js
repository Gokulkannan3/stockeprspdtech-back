const { Pool } = require('pg');
require('dotenv').config();

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

exports.getStockAnalysis = async (req, res) => {
  const client = await pool.connect();
  try {
    // ────────────────────── 1. All individual rows ──────────────────────
    const allRes = await client.query(`
      SELECT 
        COALESCE(g.name, 'Unknown') AS godown_name,
        COALESCE(s.product_type, 'Unknown') AS product_type,
        s.productname,
        COALESCE(s.brand, 'Unknown') AS brand,
        COALESCE(b.agent_name, '-') AS agent_name,
        s.current_cases AS cases,
        s.per_case,
        (s.current_cases * s.per_case) AS total_qty
      FROM public.stock s
      JOIN public.godown g ON s.godown_id = g.id
      LEFT JOIN public.brand b ON s.brand = b.name
      ORDER BY g.name, s.product_type, s.productname
    `);

    // ────────────────────── 2. Low stock (< 3 cases total) ──────────────────────
    const lowRes = await client.query(`
      SELECT 
        s.product_type,
        s.productname,
        s.brand,
        COALESCE(b.agent_name, '-') AS agent_name,
        SUM(s.current_cases) AS total_cases,
        SUM(s.current_cases * s.per_case) AS total_qty
      FROM public.stock s
      LEFT JOIN public.brand b ON s.brand = b.name
      GROUP BY s.product_type, s.productname, s.brand, b.agent_name
      HAVING SUM(s.current_cases) < 3
      ORDER BY total_cases ASC
    `);

    // ────────────────────── 3. Godown-wise total cases ──────────────────────
    const godownRes = await client.query(`
      SELECT 
        g.name AS godown_name,
        SUM(s.current_cases) AS total_cases
      FROM public.stock s
      JOIN public.godown g ON s.godown_id = g.id
      GROUP BY g.name
      ORDER BY total_cases DESC
    `);

    // ────────────────────── 4. Product-wise total cases (all godowns) ──────────────────────
    const productRes = await client.query(`
      SELECT 
        s.product_type,
        s.productname,
        s.brand,
        COALESCE(b.agent_name, '-') AS agent_name,
        SUM(s.current_cases) AS total_cases,
        SUM(s.current_cases * s.per_case) AS total_qty
      FROM public.stock s
      LEFT JOIN public.brand b ON s.brand = b.name
      GROUP BY s.product_type, s.productname, s.brand, b.agent_name
      ORDER BY total_cases DESC
    `);

    // ────────────────────── 5. Grand total ──────────────────────
    const grandRes = await client.query(`
      SELECT 
        COUNT(DISTINCT s.product_type || s.productname || s.brand) AS unique_products,
        SUM(s.current_cases) AS total_cases,
        SUM(s.current_cases * s.per_case) AS total_quantity
      FROM public.stock s
    `);

    res.json({
      allRows: allRes.rows,
      lowStock: lowRes.rows,
      godownSummary: godownRes.rows,
      productSummary: productRes.rows,
      grandTotal: grandRes.rows[0] || { unique_products: 0, total_cases: 0, total_quantity: 0 }
    });
  } catch (err) {
    console.error('StockAnalysis error:', err);
    res.status(500).json({ error: 'Failed to fetch analysis' });
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// OVERALL PERFORMANCE ANALYSIS (Sales vs Purchase & Business Intelligence)
// ─────────────────────────────────────────────────────────────────────────────
exports.getPerformanceAnalysis = async (req, res) => {
  const client = await pool.connect();
  try {
    // 1. Sales summary (from public.bookings)
    const salesSummaryRes = await client.query(`
      SELECT 
        COUNT(b.id)::INTEGER AS total_orders,
        COALESCE(SUM(b.total), 0)::NUMERIC AS total_sales_amount
      FROM public.bookings b
    `);

    // 2. Sales payments collected (from public.payments)
    const salesPaidRes = await client.query(`
      SELECT COALESCE(SUM(amount_paid), 0)::NUMERIC AS total_sales_collected
      FROM public.payments
    `);

    // 3. Purchase summary (from public.purchases)
    let purchaseSummaryRes = { rows: [{ total_purchases: 0, total_purchase_amount: 0 }] };
    let purchasePaidRes = { rows: [{ total_purchase_paid: 0 }] };

    try {
      purchaseSummaryRes = await client.query(`
        SELECT 
          COUNT(p.id)::INTEGER AS total_purchases,
          COALESCE(SUM(p.total), 0)::NUMERIC AS total_purchase_amount
        FROM public.purchases p
      `);
      purchasePaidRes = await client.query(`
        SELECT COALESCE(SUM(amount_paid), 0)::NUMERIC AS total_purchase_paid
        FROM public.purchase_payments
      `);
    } catch (e) {
      console.log('Purchases table query fallback:', e.message);
    }

    // 4. Sales dispatches summary (from public.dispatch_logs)
    let salesDispatchRes = { rows: [{ total_dispatched_cases: 0, total_dispatched_qty: 0 }] };
    try {
      salesDispatchRes = await client.query(`
        SELECT 
          COALESCE(SUM(dispatched_cases), 0)::INTEGER AS total_dispatched_cases,
          COALESCE(SUM(dispatched_qty), 0)::INTEGER AS total_dispatched_qty
        FROM public.dispatch_logs
      `);
    } catch (e) { }

    // 5. Purchase dispatches summary (from public.purchase_dispatch_logs)
    let purchaseDispatchRes = { rows: [{ total_received_cases: 0, total_received_qty: 0 }] };
    try {
      purchaseDispatchRes = await client.query(`
        SELECT 
          COALESCE(SUM(dispatched_cases), 0)::INTEGER AS total_received_cases,
          COALESCE(SUM(dispatched_qty), 0)::INTEGER AS total_received_qty
        FROM public.purchase_dispatch_logs
      `);
    } catch (e) { }

    // 6. Top Customers (Sales)
    const topCustomersRes = await client.query(`
      SELECT 
        b.customer_name,
        COUNT(b.id)::INTEGER AS order_count,
        COALESCE(SUM(b.total), 0)::NUMERIC AS total_spent,
        COALESCE(SUM(p.paid), 0)::NUMERIC AS amount_paid,
        (COALESCE(SUM(b.total), 0) - COALESCE(SUM(p.paid), 0))::NUMERIC AS balance_due
      FROM public.bookings b
      LEFT JOIN (
        SELECT booking_id, SUM(amount_paid) AS paid
        FROM public.payments
        GROUP BY booking_id
      ) p ON p.booking_id = b.id
      GROUP BY b.customer_name
      ORDER BY total_spent DESC
      LIMIT 10
    `);

    // 7. Top Suppliers (Purchases)
    let topSuppliersRes = { rows: [] };
    try {
      topSuppliersRes = await client.query(`
        SELECT 
          pu.supplier_name,
          COUNT(pu.id)::INTEGER AS po_count,
          COALESCE(SUM(pu.total), 0)::NUMERIC AS total_purchased,
          COALESCE(SUM(pp.paid), 0)::NUMERIC AS amount_paid,
          (COALESCE(SUM(pu.total), 0) - COALESCE(SUM(pp.paid), 0))::NUMERIC AS balance_payable
        FROM public.purchases pu
        LEFT JOIN (
          SELECT purchase_id, SUM(amount_paid) AS paid
          FROM public.purchase_payments
          GROUP BY purchase_id
        ) pp ON pp.purchase_id = pu.id
        GROUP BY pu.supplier_name
        ORDER BY total_purchased DESC
        LIMIT 10
      `);
    } catch (e) { }

    // 8. Monthly Sales vs Purchases Trend
    const monthlySalesRes = await client.query(`
      SELECT 
        TO_CHAR(created_at, 'YYYY-MM') AS month_key,
        TO_CHAR(created_at, 'Mon YYYY') AS month_label,
        COALESCE(SUM(total), 0)::NUMERIC AS sales_amount,
        COUNT(id)::INTEGER AS sales_count
      FROM public.bookings
      GROUP BY month_key, month_label
      ORDER BY month_key ASC
      LIMIT 12
    `);

    let monthlyPurchasesRes = { rows: [] };
    try {
      monthlyPurchasesRes = await client.query(`
        SELECT 
          TO_CHAR(created_at, 'YYYY-MM') AS month_key,
          TO_CHAR(created_at, 'Mon YYYY') AS month_label,
          COALESCE(SUM(total), 0)::NUMERIC AS purchase_amount,
          COUNT(id)::INTEGER AS purchase_count
        FROM public.purchases
        GROUP BY month_key, month_label
        ORDER BY month_key ASC
        LIMIT 12
      `);
    } catch (e) { }

    // Merge monthly trends
    const monthMap = {};
    monthlySalesRes.rows.forEach(r => {
      monthMap[r.month_key] = {
        month_key: r.month_key,
        month_label: r.month_label,
        sales: parseFloat(r.sales_amount) || 0,
        sales_count: r.sales_count,
        purchases: 0,
        purchase_count: 0
      };
    });

    monthlyPurchasesRes.rows.forEach(r => {
      if (!monthMap[r.month_key]) {
        monthMap[r.month_key] = {
          month_key: r.month_key,
          month_label: r.month_label,
          sales: 0,
          sales_count: 0,
          purchases: parseFloat(r.purchase_amount) || 0,
          purchase_count: r.purchase_count
        };
      } else {
        monthMap[r.month_key].purchases = parseFloat(r.purchase_amount) || 0;
        monthMap[r.month_key].purchase_count = r.purchase_count;
      }
    });

    const monthlyTrends = Object.values(monthMap).sort((a, b) => a.month_key.localeCompare(b.month_key));

    // 9. Product Item Level Performance (Sales vs Purchase)
    const salesItemsRes = await client.query(`SELECT items FROM public.bookings WHERE items IS NOT NULL`);
    let purchaseItemsRes = { rows: [] };
    try {
      purchaseItemsRes = await client.query(`SELECT items FROM public.purchases WHERE items IS NOT NULL`);
    } catch (e) { }

    const productPerfMap = {};

    // Brand-wise performance map
    const brandPerfMap = {};

    salesItemsRes.rows.forEach(row => {
      const items = typeof row.items === 'string' ? JSON.parse(row.items || '[]') : row.items || [];
      items.forEach(i => {
        const name = (i.productname || i.product_name || 'Unknown').trim();
        const brand = (i.brand || 'General').trim();
        if (!name) return;
        if (!productPerfMap[name]) {
          productPerfMap[name] = {
            productname: name,
            brand,
            sold_cases: 0,
            sold_qty: 0,
            sold_amount: 0,
            purchased_cases: 0,
            purchased_qty: 0,
            purchased_amount: 0
          };
        }
        productPerfMap[name].sold_cases += parseInt(i.cases) || 0;
        productPerfMap[name].sold_qty += parseInt(i.quantity) || ((parseInt(i.cases) || 0) * (parseInt(i.per_case) || 1));
        productPerfMap[name].sold_amount += parseFloat(i.amount) || 0;

        if (!brandPerfMap[brand]) {
          brandPerfMap[brand] = { brand, sales: 0, purchases: 0, sold_cases: 0, purchased_cases: 0 };
        }
        brandPerfMap[brand].sales += parseFloat(i.amount) || 0;
        brandPerfMap[brand].sold_cases += parseInt(i.cases) || 0;
      });
    });

    purchaseItemsRes.rows.forEach(row => {
      const items = typeof row.items === 'string' ? JSON.parse(row.items || '[]') : row.items || [];
      items.forEach(i => {
        const name = (i.productname || i.product_name || 'Unknown').trim();
        const brand = (i.brand || 'General').trim();
        if (!name) return;
        if (!productPerfMap[name]) {
          productPerfMap[name] = {
            productname: name,
            brand,
            sold_cases: 0,
            sold_qty: 0,
            sold_amount: 0,
            purchased_cases: 0,
            purchased_qty: 0,
            purchased_amount: 0
          };
        }
        productPerfMap[name].purchased_cases += parseInt(i.cases) || 0;
        productPerfMap[name].purchased_qty += parseInt(i.quantity) || ((parseInt(i.cases) || 0) * (parseInt(i.per_case) || 1));
        productPerfMap[name].purchased_amount += parseFloat(i.amount) || 0;

        if (!brandPerfMap[brand]) {
          brandPerfMap[brand] = { brand, sales: 0, purchases: 0, sold_cases: 0, purchased_cases: 0 };
        }
        brandPerfMap[brand].purchases += parseFloat(i.amount) || 0;
        brandPerfMap[brand].purchased_cases += parseInt(i.cases) || 0;
      });
    });

    // Enriched Product Performance List
    const allProductsList = Object.values(productPerfMap).map(p => {
      const netMargin = p.sold_amount - p.purchased_amount;
      const sellThrough = p.purchased_cases > 0
        ? Math.min(100, Math.round((p.sold_cases / p.purchased_cases) * 100))
        : (p.sold_cases > 0 ? 100 : 0);
      const avgBuyRate = p.purchased_qty > 0 ? (p.purchased_amount / p.purchased_qty).toFixed(2) : '0.00';
      const avgSellRate = p.sold_qty > 0 ? (p.sold_amount / p.sold_qty).toFixed(2) : '0.00';

      let velocity = 'NORMAL';
      if (p.sold_cases >= 5 || sellThrough >= 75) velocity = 'FAST MOVER';
      else if (p.sold_cases === 0 || (p.purchased_cases > 0 && sellThrough <= 20)) velocity = 'SLOW MOVER';

      return {
        ...p,
        net_margin: parseFloat(netMargin.toFixed(2)),
        sell_through_percent: sellThrough,
        avg_buy_rate: avgBuyRate,
        avg_sell_rate: avgSellRate,
        velocity
      };
    });

    const topProducts = allProductsList
      .sort((a, b) => (b.sold_amount + b.purchased_amount) - (a.sold_amount + a.purchased_amount))
      .slice(0, 20);

    const fastMovers = allProductsList.filter(p => p.velocity === 'FAST MOVER');
    const slowMovers = allProductsList.filter(p => p.velocity === 'SLOW MOVER');

    const brandPerformance = Object.values(brandPerfMap).map(b => ({
      ...b,
      net_margin: parseFloat((b.sales - b.purchases).toFixed(2))
    })).sort((a, b) => (b.sales + b.purchases) - (a.sales + a.purchases));

    // 10. Stock Health & Godown Valuation
    let stockHealthRes = { rows: [{ total_products: 0, total_cases: 0, total_qty: 0 }] };
    try {
      stockHealthRes = await client.query(`
        SELECT 
          COUNT(DISTINCT productname)::INTEGER AS total_products,
          COALESCE(SUM(current_cases), 0)::INTEGER AS total_cases,
          COALESCE(SUM(current_cases * per_case), 0)::INTEGER AS total_qty
        FROM public.stock
      `);
    } catch (e) { }

    // Calculation Totals
    const salesTotal = parseFloat(salesSummaryRes.rows[0]?.total_sales_amount || 0);
    const salesCount = salesSummaryRes.rows[0]?.total_orders || 0;
    const salesCollected = parseFloat(salesPaidRes.rows[0]?.total_sales_collected || 0);
    const salesOutstanding = Math.max(0, salesTotal - salesCollected);

    const purchaseTotal = parseFloat(purchaseSummaryRes.rows[0]?.total_purchase_amount || 0);
    const purchaseCount = purchaseSummaryRes.rows[0]?.total_purchases || 0;
    const purchasePaid = parseFloat(purchasePaidRes.rows[0]?.total_purchase_paid || 0);
    const purchasePayable = Math.max(0, purchaseTotal - purchasePaid);

    const grossMargin = salesTotal - purchaseTotal;
    const marginPercentage = salesTotal > 0 ? ((grossMargin / salesTotal) * 100).toFixed(1) : '0.0';
    const netCashFlow = salesCollected - purchasePaid;

    const salesDispatchedCases = salesDispatchRes.rows[0]?.total_dispatched_cases || 0;
    const purchaseReceivedCases = purchaseDispatchRes.rows[0]?.total_received_cases || 0;

    const totalSoldCases = allProductsList.reduce((s, p) => s + p.sold_cases, 0);
    const totalPurchasedCases = allProductsList.reduce((s, p) => s + p.purchased_cases, 0);

    const salesFulfillmentRate = totalSoldCases > 0 ? Math.min(100, Math.round((salesDispatchedCases / totalSoldCases) * 100)) : 100;
    const purchaseFulfillmentRate = totalPurchasedCases > 0 ? Math.min(100, Math.round((purchaseReceivedCases / totalPurchasedCases) * 100)) : 100;

    res.json({
      summary: {
        salesTotal,
        salesCount,
        salesCollected,
        salesOutstanding,
        purchaseTotal,
        purchaseCount,
        purchasePaid,
        purchasePayable,
        grossMargin,
        marginPercentage,
        netCashFlow
      },
      dispatches: {
        salesDispatchedCases,
        salesDispatchedQty: salesDispatchRes.rows[0]?.total_dispatched_qty || 0,
        purchaseReceivedCases,
        purchaseReceivedQty: purchaseDispatchRes.rows[0]?.total_received_qty || 0,
        salesFulfillmentRate,
        purchaseFulfillmentRate
      },
      topCustomers: topCustomersRes.rows,
      topSuppliers: topSuppliersRes.rows,
      monthlyTrends,
      topProducts,
      fastMovers,
      slowMovers,
      brandPerformance,
      stockHealth: stockHealthRes.rows[0] || { total_products: 0, total_cases: 0, total_qty: 0 }
    });

  } catch (err) {
    console.error('getPerformanceAnalysis error:', err);
    res.status(500).json({ error: 'Failed to fetch performance analysis' });
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// MASTER PRODUCT TALLY LEDGER & AUDIT REPORT
// ─────────────────────────────────────────────────────────────────────────────
exports.getProductTallyLedger = async (req, res) => {
  const client = await pool.connect();
  try {
    const tallyMap = {};

    const getOrCreateEntry = (pName, brandName) => {
      const name = (pName || 'Unknown').trim();
      const brand = (brandName || 'General').trim();
      const key = `${name}___${brand}`.toLowerCase();
      if (!tallyMap[key]) {
        tallyMap[key] = {
          key,
          productname: name,
          brand,
          purchased_cases: 0,
          purchased_qty: 0,
          purchased_amount: 0,
          purchase_received_cases: 0,
          purchase_received_qty: 0,
          sales_cases: 0,
          sales_qty: 0,
          sales_amount: 0,
          sales_dispatched_cases: 0,
          sales_dispatched_qty: 0,
          current_stock_cases: 0,
          current_stock_qty: 0,
          godown_locations: new Set()
        };
      }
      return tallyMap[key];
    };

    // 1. Parse Purchases
    const purchaseRows = await client.query(`SELECT items FROM public.purchases WHERE items IS NOT NULL`);
    purchaseRows.rows.forEach(r => {
      const items = typeof r.items === 'string' ? JSON.parse(r.items || '[]') : r.items || [];
      items.forEach(i => {
        const entry = getOrCreateEntry(i.productname, i.brand);
        const cases = parseInt(i.cases) || 0;
        const per = parseInt(i.per_case) || 1;
        const qty = parseInt(i.quantity) || (cases * per);
        const amt = parseFloat(i.amount) || (qty * (parseFloat(i.rate_per_box) || 0));
        entry.purchased_cases += cases;
        entry.purchased_qty += qty;
        entry.purchased_amount += amt;
      });
    });

    // 2. Parse Purchase Dispatches (Goods Received into Godown)
    try {
      const purDispatchRows = await client.query(`SELECT product_name, brand, dispatched_cases, dispatched_qty, godown FROM public.purchase_dispatch_logs`);
      purDispatchRows.rows.forEach(d => {
        const entry = getOrCreateEntry(d.product_name, d.brand);
        entry.purchase_received_cases += parseInt(d.dispatched_cases) || 0;
        entry.purchase_received_qty += parseInt(d.dispatched_qty) || 0;
        if (d.godown) entry.godown_locations.add(d.godown);
      });
    } catch (e) { }

    // 3. Parse Sales / Bookings
    const salesRows = await client.query(`SELECT items FROM public.bookings WHERE items IS NOT NULL`);
    salesRows.rows.forEach(r => {
      const items = typeof r.items === 'string' ? JSON.parse(r.items || '[]') : r.items || [];
      items.forEach(i => {
        const entry = getOrCreateEntry(i.productname, i.brand);
        const cases = parseInt(i.cases) || 0;
        const per = parseInt(i.per_case) || 1;
        const qty = parseInt(i.quantity) || (cases * per);
        const amt = parseFloat(i.amount) || (qty * (parseFloat(i.rate_per_box) || 0));
        entry.sales_cases += cases;
        entry.sales_qty += qty;
        entry.sales_amount += amt;
      });
    });

    // 4. Parse Sales Dispatches (Goods Sent to Customer)
    try {
      const salesDispatchRows = await client.query(`SELECT product_name, brand, dispatched_cases, dispatched_qty, godown_name FROM public.dispatch_logs`);
      salesDispatchRows.rows.forEach(d => {
        const entry = getOrCreateEntry(d.product_name, d.brand);
        entry.sales_dispatched_cases += parseInt(d.dispatched_cases) || 0;
        entry.sales_dispatched_qty += parseInt(d.dispatched_qty) || 0;
        if (d.godown_name) entry.godown_locations.add(d.godown_name);
      });
    } catch (e) { }

    // 5. Parse Current Godown Stock
    try {
      const stockRows = await client.query(`
        SELECT s.productname, s.brand, s.current_cases, s.per_case, g.name AS godown_name
        FROM public.stock s
        JOIN public.godown g ON s.godown_id = g.id
      `);
      stockRows.rows.forEach(s => {
        const entry = getOrCreateEntry(s.productname, s.brand);
        const cases = parseInt(s.current_cases) || 0;
        const per = parseInt(s.per_case) || 1;
        entry.current_stock_cases += cases;
        entry.current_stock_qty += (cases * per);
        if (s.godown_name) entry.godown_locations.add(s.godown_name);
      });
    } catch (e) { }

    // Convert map to array and compute audit fields
    const productTally = Object.values(tallyMap).map(e => {
      const netMargin = e.sales_amount - e.purchased_amount;
      const expectedStockCases = e.purchase_received_cases - e.sales_dispatched_cases;
      const stockDiff = e.current_stock_cases - expectedStockCases;

      let status = 'PERFECT MATCH';
      if (stockDiff > 0) status = `SURPLUS (+${stockDiff} cases)`;
      else if (stockDiff < 0) status = `DEFICIT (${stockDiff} cases)`;

      return {
        ...e,
        godown_locations: Array.from(e.godown_locations).join(', ') || 'Main Location',
        net_margin: parseFloat(netMargin.toFixed(2)),
        expected_stock_cases: expectedStockCases,
        stock_diff: stockDiff,
        status
      };
    }).sort((a, b) => (b.sales_amount + b.purchased_amount) - (a.sales_amount + a.purchased_amount));

    // Calculate Summary Totals
    const totalPurchasedAmount = productTally.reduce((s, p) => s + p.purchased_amount, 0);
    const totalSalesAmount = productTally.reduce((s, p) => s + p.sales_amount, 0);
    const totalNetProfit = totalSalesAmount - totalPurchasedAmount;
    const totalPurchasedCases = productTally.reduce((s, p) => s + p.purchased_cases, 0);
    const totalSalesCases = productTally.reduce((s, p) => s + p.sales_cases, 0);
    const totalGodownCases = productTally.reduce((s, p) => s + p.current_stock_cases, 0);

    res.json({
      summary: {
        totalProducts: productTally.length,
        totalPurchasedAmount,
        totalSalesAmount,
        totalNetProfit,
        totalPurchasedCases,
        totalSalesCases,
        totalGodownCases
      },
      tally: productTally
    });

  } catch (err) {
    console.error('getProductTallyLedger error:', err);
    res.status(500).json({ error: 'Failed to generate product tally ledger' });
  } finally {
    client.release();
  }
};