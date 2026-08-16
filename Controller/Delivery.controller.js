// Controller/Delivery.controller.js
const { Pool } = require('pg');
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
const { getNextSequenceNumber } = require('../utils/sequence');

exports.createDeliveryChallan = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const {
      name, address, gstin, lr_number,
      from = 'SIVAKASI', to, through, items
    } = req.body;

    const user = req.body.created_by || 'Admin';
    const sequenceNumber = await getNextSequenceNumber();
    const challan_number = `DC-${sequenceNumber}`;

    const itemsToStore = [];

    for (const item of items) {
      const { id, cases, per_case, productname, brand, godown, product_type } = item;

      if (!product_type) {
        throw new Error(`product_type required for item ${productname || id}`);
      }

      // Fetch only per_case from stock (for validation & history)
      const stockRes = await client.query(
        `SELECT per_case FROM public.stock WHERE id = $1`,
        [id]
      );

      if (stockRes.rows.length === 0) {
        throw new Error(`Stock item ${id} not found`);
      }

      const realPerCase = Number(stockRes.rows[0].per_case) || per_case || 1;

      // Reduce stock
      await client.query(
        `UPDATE stock 
         SET current_cases = current_cases - $1,
             taken_cases = COALESCE(taken_cases, 0) + $1 
         WHERE id = $2`,
        [cases, id]
      );

      // Stock history
      await client.query(
        `INSERT INTO stock_history 
         (stock_id, action, cases, per_case_total, date, customer_name)
         VALUES ($1, $2, $3, $4, NOW(), $5)`,
        [id, 'taken', cases, cases * realPerCase, name]
      );

      // Store item WITHOUT rate_per_box
      itemsToStore.push({
        id,
        productname: productname?.trim() || '',
        brand: brand?.trim() || '',
        cases: Number(cases),
        per_case: realPerCase,
        godown: godown?.trim() || from,
        product_type  // important for later lookup
      });
    }

    // Insert challan — items now have no rate_per_box
    await client.query(
      `INSERT INTO delivery (
        challan_number, customer_name, address, gstin, lr_number,
        "from", "to", through, items, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        challan_number, name, address, gstin, lr_number,
        from, to, through, JSON.stringify(itemsToStore), user
      ]
    );

    await client.query('COMMIT');
    res.json({ challan_number, message: 'Challan created successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error in createDeliveryChallan:', err);
    res.status(500).json({ message: err.message || 'Internal server error' });
  } finally {
    client.release();
  }
};

exports.getPendingChallans = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, challan_number, customer_name, "to", created_at, created_by 
      FROM delivery 
      WHERE converted_to_bill = FALSE 
      ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch pending challans' });
  }
};

exports.getChallanById = async (req, res) => {
  try {
    const { id } = req.params;

    const challanResult = await pool.query(
      `SELECT * FROM delivery WHERE id = $1`,
      [id]
    );

    if (challanResult.rows.length === 0) {
      return res.status(404).json({ message: 'Challan not found' });
    }

    const challan = challanResult.rows[0];
    let items = [];

    if (challan.items) {
      try {
        items = typeof challan.items === 'string'
          ? JSON.parse(challan.items)
          : challan.items;
      } catch (e) {
        console.error('JSON parse error in items:', e);
        items = [];
      }
    }

    // Step 1: Collect all unique product names to fetch master data in one query
    const productNames = [...new Set(items.map(i => i.productname).filter(Boolean))];

    if (productNames.length === 0) {
      // No products → just return as-is with type enforcement
      items = items.map(item => ({
        ...item,
        rate_per_box: parseFloat(item.rate_per_box) || 0,
        per_case: Number(item.per_case) || 1,
        cases: Number(item.cases) || 0
      }));
      return res.json({ ...challan, items });
    }

    // Step 2: Fetch latest price & per_case from all dynamic tables
    // We need to query every product_type table that might contain these products
    const typesResult = await pool.query('SELECT product_type FROM public.products');
    const typeTables = typesResult.rows.map(t =>
      t.product_type.toLowerCase().replace(/\s+/g, '_')
    );

    let masterRows = [];

    // Query each table (this is acceptable since number of product_types is small)
    for (const tbl of typeTables) {
      try {
        const rows = await pool.query(`
          SELECT 
            productname,
            price AS rate_per_box,
            per_case
          FROM public."${tbl}"
          WHERE productname = ANY($1)
        `, [productNames]);

        masterRows.push(...rows.rows);
      } catch (tableErr) {
        // Ignore missing type table
      }
    }

    // Build lookup map: productname → { rate_per_box, per_case }
    const masterMap = new Map();
    masterRows.forEach(m => {
      masterMap.set(m.productname.toLowerCase(), {
        rate_per_box: parseFloat(m.rate_per_box) || 0,
        per_case: Number(m.per_case) || 1
      });
    });

    // Step 3: Enrich challan items with latest master values
    items = items.map(item => {
      const key = (item.productname || '').toLowerCase().trim();
      const master = masterMap.get(key);

      return {
        ...item,
        // Use master values if found, fallback to whatever was saved
        rate_per_box: master ? master.rate_per_box : (parseFloat(item.rate_per_box) || 0),
        per_case: master ? master.per_case : (Number(item.per_case) || 1),
        cases: Number(item.cases) || 0,
        discount_percent: parseFloat(item.discount_percent || item.discount) || 0
      };
    });

    res.json({
      ...challan,
      items
    });
  } catch (err) {
    console.error('getChallanById Error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};