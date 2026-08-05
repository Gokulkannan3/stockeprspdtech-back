const { Pool } = require('pg');
const ExcelJS = require('exceljs');

const pool = new Pool({
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
  ssl: {
    rejectUnauthorized: false,
  },
});

exports.addGodown = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ message: 'Godown name is required' });
    }
    const formattedName = name.toLowerCase().replace(/\s+/g, '_');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.godown (
        id BIGSERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE
      )
    `);
    const checkQuery = 'SELECT name FROM public.godown WHERE name = $1';
    const checkResult = await pool.query(checkQuery, [formattedName]);
    if (checkResult.rows.length > 0) {
      return res.status(400).json({ message: 'Godown already exists' });
    }
    const insertQuery = 'INSERT INTO public.godown (name) VALUES ($1) RETURNING id';
    const result = await pool.query(insertQuery, [formattedName]);
    res.status(201).json({ message: 'Godown created successfully', id: result.rows[0].id });
  } catch (err) {
    console.error('Error in addGodown:', err.message);
    res.status(500).json({ message: 'Failed to create godown' });
  }
};

exports.getGodowns = async (req, res) => {
  try {
    const godownsResult = await pool.query('SELECT id, name FROM public.godown ORDER BY name');
    const godowns = godownsResult.rows;
    for (let godown of godowns) {
      const stockResult = await pool.query(
        `SELECT
            s.id,
            s.product_type,
            s.productname,
            s.brand,
            s.current_cases,
            s.per_case,
            s.date_added,
            s.last_taken_date,
            s.taken_cases,
            COALESCE(b.agent_name, '-') AS agent_name
         FROM public.stock s
         LEFT JOIN public.brand b ON s.brand = b.name
         WHERE s.godown_id = $1
         ORDER BY s.productname`,
        [godown.id]
      );
      godown.stocks = stockResult.rows;
    }
    res.status(200).json(godowns);
  } catch (err) {
    console.error('Error in getGodowns:', err.message);
    res.status(500).json({ message: 'Failed to fetch godowns' });
  }
};

exports.deleteGodown = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM public.godown WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Godown not found' });
    }
    res.status(200).json({ message: 'Godown deleted successfully' });
  } catch (err) {
    console.error('Error in deleteGodown:', err.message);
    res.status(500).json({ message: 'Failed to delete godown' });
  }
};

exports.addStockToGodown = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { godown_id, product_type, productname, brand, cases_added, added_date } = req.body;

    if (!godown_id || !product_type || !productname || !brand || !cases_added) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    const casesAddedNum = parseInt(cases_added, 10);
    if (isNaN(casesAddedNum) || casesAddedNum <= 0) {
      return res.status(400).json({ message: 'Cases must be a positive number' });
    }

    // Validate godown
    const godownCheck = await client.query('SELECT id FROM public.godown WHERE id = $1', [godown_id]);
    if (godownCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Godown not found' });
    }

    // Validate product in its type table
    const tableName = product_type.toLowerCase().replace(/\s+/g, '_');
    const productCheck = await client.query(
      `SELECT id, per_case FROM public."${tableName}" WHERE productname = $1 AND brand = $2`,
      [productname, brand]
    );
    if (productCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Product not found in type table' });
    }
    const per_case = productCheck.rows[0].per_case;

    // Ensure stock table exists
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
        CONSTRAINT unique_stock_entry UNIQUE (godown_id, product_type, productname, brand)
      )
    `);

    // Ensure brand table & get brand_id
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.brand (
        id BIGSERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        agent_name VARCHAR(100)
      )
    `);

    const formattedBrand = brand.toLowerCase().replace(/\s+/g, '_');
    let brandResult = await client.query('SELECT id FROM public.brand WHERE name = $1', [formattedBrand]);
    if (brandResult.rows.length === 0) {
      const insertBrand = await client.query(
        'INSERT INTO public.brand (name) VALUES ($1) RETURNING id',
        [formattedBrand]
      );
      brandResult = insertBrand;
    }
    const brand_id = brandResult.rows[0].id;

    // Add brand_id column if not exists
    await client.query(`
      ALTER TABLE public.stock 
      ADD COLUMN IF NOT EXISTS brand_id INTEGER REFERENCES public.brand(id)
    `);

    // Check existing stock
    let stockId;
    const existingStock = await client.query(
      'SELECT id, current_cases FROM public.stock WHERE godown_id = $1 AND product_type = $2 AND productname = $3 AND brand = $4',
      [godown_id, product_type, productname, brand]
    );

    // Use added_date as string directly (YYYY-MM-DD) or null
    const customDate = added_date || null;

    if (existingStock.rows.length > 0) {
      stockId = existingStock.rows[0].id;
      const newCases = existingStock.rows[0].current_cases + casesAddedNum;

      await client.query(
        'UPDATE public.stock SET current_cases = $1, date_added = COALESCE($2, CURRENT_TIMESTAMP), brand_id = $3 WHERE id = $4',
        [newCases, customDate, brand_id, stockId]
      );
    } else {
      const insertResult = await client.query(
        `INSERT INTO public.stock 
         (godown_id, product_type, productname, brand, brand_id, current_cases, per_case, date_added) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, CURRENT_TIMESTAMP)) RETURNING id`,
        [godown_id, product_type, productname, brand, brand_id, casesAddedNum, per_case, customDate]
      );
      stockId = insertResult.rows[0].id;
    }

    // Insert into history (same approach)
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
      'INSERT INTO public.stock_history (stock_id, action, cases, per_case_total, added_by, date) VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_TIMESTAMP))',
      [stockId, 'added', casesAddedNum, casesAddedNum * per_case, req.body.added_by || 'Unknown', customDate]
    );

    await client.query('COMMIT');
    res.status(201).json({ message: 'Stock added successfully', stock_id: stockId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error in addStockToGodown:', err.message);
    res.status(500).json({ message: 'Failed to add stock', error: err.message });
  } finally {
    client.release();
  }
};

exports.getStockByGodown = async (req, res) => {
  const { godown_id } = req.params;

  try {
    const typesRes = await pool.query(`
      SELECT DISTINCT product_type
      FROM public.stock 
      WHERE godown_id = $1
    `, [godown_id]);

    if (typesRes.rows.length === 0) return res.json([]);

    const productTypes = typesRes.rows.map(r => r.product_type);
    let joins = '';
    const params = [godown_id];
    let idx = 2;

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
          ${productTypes.map((_, i) => `CAST(p${i + 2}.price AS NUMERIC)`).join(', ')}, 
          0
        )::NUMERIC AS rate_per_box,
        g.name AS godown_name,
        COALESCE(b.agent_name, '-') AS agent_name
      FROM public.stock s
      JOIN public.godown g ON s.godown_id = g.id
      LEFT JOIN public.brand b ON s.brand = b.name
      ${joins}
      WHERE s.godown_id = $1
      ORDER BY s.product_type, s.productname
    `;

    const result = await pool.query(finalQuery, params);
    res.json(result.rows);
  } catch (err) {
    console.error('getStockByGodown:', err.message);
    res.status(500).json({ message: 'Failed to fetch stock' });
  }
};

exports.takeStockFromGodown = async (req, res) => {
  const client = await pool.connect();
  try {
    const { stock_id, cases_taken } = req.body;
    if (!stock_id) {
      return res.status(400).json({ message: 'Stock ID is required' });
    }
    if (!cases_taken || parseInt(cases_taken) <= 0) {
      return res.status(400).json({ message: 'Valid cases to take is required' });
    }

    await client.query('BEGIN');

    const stockCheck = await client.query(
      'SELECT current_cases, per_case, taken_cases FROM public.stock WHERE id = $1 FOR UPDATE',
      [stock_id]
    );

    if (stockCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Stock entry not found' });
    }

    const { current_cases, per_case, taken_cases } = stockCheck.rows[0];
    if (parseInt(cases_taken) > current_cases) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Insufficient stock' });
    }

    const newCases = current_cases - parseInt(cases_taken);
    const newTakenCases = (taken_cases || 0) + parseInt(cases_taken);

    await client.query(
      'UPDATE public.stock SET current_cases = $1, taken_cases = $2, last_taken_date = CURRENT_TIMESTAMP WHERE id = $3',
      [newCases, newTakenCases, stock_id]
    );

    await client.query(
      'INSERT INTO public.stock_history (stock_id, action, cases, per_case_total) VALUES ($1, $2, $3, $4)',
      [stock_id, 'taken', parseInt(cases_taken), parseInt(cases_taken) * per_case]
    );

    await client.query('COMMIT');
    res.status(200).json({ message: 'Stock taken successfully', new_cases: newCases });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error in takeStockFromGodown:', err.message);
    res.status(500).json({ message: 'Failed to take stock' });
  } finally {
    client.release();
  }
};

exports.addStockToExisting = async (req, res) => {
  try {
    const { stock_id, cases_added } = req.body;
    if (!stock_id) {
      return res.status(400).json({ message: 'Stock ID is required' });
    }
    if (!cases_added || parseInt(cases_added) <= 0) {
      return res.status(400).json({ message: 'Valid cases to add is required' });
    }

    const stockCheck = await pool.query(
      'SELECT current_cases, per_case FROM public.stock WHERE id = $1',
      [stock_id]
    );

    if (stockCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Stock entry not found' });
    }

    const { current_cases, per_case } = stockCheck.rows[0];
    const newCases = current_cases + parseInt(cases_added);

    await pool.query(
      'UPDATE public.stock SET current_cases = $1, date_added = CURRENT_TIMESTAMP WHERE id = $2',
      [newCases, stock_id]
    );

    await pool.query(
      'INSERT INTO public.stock_history (stock_id, action, cases, per_case_total) VALUES ($1, $2, $3, $4)',
      [stock_id, 'added', parseInt(cases_added), parseInt(cases_added) * per_case]
    );

    res.status(200).json({ message: 'Stock added successfully', new_cases: newCases });
  } catch (err) {
    console.error('Error in addStockToExisting:', err.message);
    res.status(500).json({ message: 'Failed to add stock' });
  }
};

exports.getStockHistory = async (req, res) => {
  try {
    const { stock_id } = req.params;
    const result = await pool.query(
      `SELECT
          h.*,
          s.productname,
          s.brand,
          s.product_type,
          s.per_case * h.cases AS per_case_total,
          COALESCE(b.agent_name, '-') AS agent_name,
          COALESCE(h.customer_name, '-') AS customer_name
       FROM public.stock_history h
       JOIN public.stock s ON h.stock_id = s.id
       LEFT JOIN public.brand b ON s.brand = b.name
       WHERE h.stock_id = $1
       ORDER BY h.date DESC`,
      [stock_id]
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error in getStockHistory:', err.message);
    res.status(500).json({ message: 'Failed to fetch stock history' });
  }
};

exports.exportGodownStockToExcel = async (req, res) => {
  try {
    const godownsResult = await pool.query('SELECT id, name FROM public.godown ORDER BY name');
    const godowns = godownsResult.rows;
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Admin System';
    workbook.lastModifiedBy = 'Admin System';

    for (const godown of godowns) {
      // ─── Only Full History Sheet ───────────────────────────────────────────────
      const historyQuery = `
        SELECT 
          h.date,
          h.action,
          h.cases,
          h.per_case_total,
          h.added_by,
          h.taken_by,
          h.customer_name,
          s.product_type,
          s.productname,
          s.brand,
          COALESCE(b.agent_name, '-') AS agent_name
        FROM public.stock_history h
        JOIN public.stock s ON h.stock_id = s.id
        LEFT JOIN public.brand b ON s.brand = b.name
        WHERE s.godown_id = $1
        ORDER BY h.date DESC
      `;
      const historyResult = await pool.query(historyQuery, [godown.id]);

      if (historyResult.rows.length === 0) continue; // skip empty godowns

      const sheet = workbook.addWorksheet(`${godown.name} - History`, {
        properties: { defaultColWidth: 20 }
      });

      sheet.columns = [
        { header: 'S.No', key: 'sno', width: 8 },
        { header: 'Date & Time', key: 'date', width: 24 },
        { header: 'Action', key: 'action', width: 14 },
        { header: 'Cases', key: 'cases', width: 12 },
        { header: 'Total Qty', key: 'per_case_total', width: 14 },
        { header: 'Product Type', key: 'product_type', width: 22 },
        { header: 'Product Name', key: 'productname', width: 35 },
        { header: 'Brand', key: 'brand', width: 18 },
        { header: 'Agent Name', key: 'agent_name', width: 20 },
        { header: 'Performed By', key: 'performed_by', width: 22 },
        { header: 'Customer / Note', key: 'customer_name', width: 40 },
      ];

      historyResult.rows.forEach((row, index) => {
        const formattedDate = row.date 
          ? new Date(row.date).toLocaleString('en-IN', {
              day: '2-digit', month: 'short', year: 'numeric',
              hour: '2-digit', minute: '2-digit', hour12: true
            })
          : '-';

        // Performed By: prioritize taken_by for OUT, added_by for IN
        let performedBy = '-';
        if (row.action === 'added') {
          performedBy = row.added_by || row.taken_by || '-';
        } else if (row.action === 'taken') {
          performedBy = row.taken_by || row.added_by || '-';
        }

        sheet.addRow({
          sno: index + 1,
          date: formattedDate,
          action: row.action === 'added' ? 'IN (Added)' : 'OUT (Taken)',
          cases: row.action === 'added' ? `+${row.cases}` : `-${row.cases}`,
          per_case_total: row.per_case_total || 0,
          product_type: row.product_type || '',
          productname: row.productname || '',
          brand: row.brand || '',
          agent_name: row.agent_name || '-',
          performed_by: performedBy,
          customer_name: row.customer_name || '-',
        });
      });

      // Header style
      sheet.getRow(1).font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E88E5' } };

      // Row coloring: green for IN, light red for OUT
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const action = row.getCell('action').value;
        if (action?.includes('IN')) {
          row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } };
        } else if (action?.includes('OUT')) {
          row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEF9A9A' } };
        }
      });
    }

    // If no godowns had history → add a message sheet
    if (workbook.worksheets.length === 0) {
      const sheet = workbook.addWorksheet('No History');
      sheet.getCell('A1').value = 'No stock history found in any godown.';
      sheet.getCell('A1').font = { size: 14, bold: true };
    }

    // Send the file
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', 'attachment; filename=godown_history_report.xlsx');
    await workbook.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error('Error in exportGodownStockToExcel:', err.message, err.stack);
    res.status(500).json({ message: 'Failed to export Excel', error: err.message });
  }
};

exports.editGodown = async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'Name required' });

    const formatted = name.toLowerCase().trim().replace(/\s+/g, '_');
    const check = await pool.query('SELECT id FROM public.godown WHERE name = $1 AND id != $2', [formatted, id]);
    if (check.rows.length > 0) return res.status(400).json({ message: 'Name already exists' });

    const result = await pool.query(
      'UPDATE public.godown SET name = $1 WHERE id = $2 RETURNING name',
      [formatted, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Godown not found' });

    res.json({ message: 'Updated', name: result.rows[0].name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update' });
  }
};

exports.getGodownsFast = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        g.id, 
        g.name,
        COALESCE(SUM(s.current_cases), 0) AS total_cases,
        COUNT(s.id) AS stock_items
      FROM public.godown g
      LEFT JOIN public.stock s ON s.godown_id = g.id
      GROUP BY g.id, g.name
      ORDER BY g.name
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed' });
  }
};

exports.bulkAllocate = async (req, res) => {
  const client = await pool.connect();
  try {
    const { allocations } = req.body;
    if (!Array.isArray(allocations) || allocations.length === 0) {
      return res.status(400).json({ message: 'No allocations provided' });
    }

    await client.query('BEGIN');

    const results = [];

    for (const alloc of allocations) {
      const {
        godown_id,
        product_type,
        productname,
        brand,
        per_case,
        cases_added,
        added_date
      } = alloc;

      const cases = parseInt(cases_added, 10);
      if (isNaN(cases) || cases <= 0) continue;

      const fmtBrand = brand.toLowerCase().replace(/\s+/g, '_');
      let brandRes = await client.query(
        'SELECT id FROM public.brand WHERE name = $1',
        [fmtBrand]
      );
      if (brandRes.rows.length === 0) {
        brandRes = await client.query(
          'INSERT INTO public.brand (name) VALUES ($1) RETURNING id',
          [fmtBrand]
        );
      }
      const brand_id = brandRes.rows[0].id;

      // Use added_date as string directly (YYYY-MM-DD) or null
      const customDate = added_date || null;

      const exist = await client.query(
        `SELECT id, current_cases FROM public.stock 
         WHERE godown_id = $1 AND product_type = $2 AND productname = $3 AND brand = $4`,
        [godown_id, product_type, productname, brand]
      );

      let stockId;
      if (exist.rows.length > 0) {
        stockId = exist.rows[0].id;
        const newCases = exist.rows[0].current_cases + cases;
        await client.query(
          `UPDATE public.stock 
           SET current_cases = $1, date_added = COALESCE($2, CURRENT_TIMESTAMP), brand_id = $3 
           WHERE id = $4`,
          [newCases, customDate, brand_id, stockId]
        );
      } else {
        const ins = await client.query(
          `INSERT INTO public.stock 
           (godown_id, product_type, productname, brand, brand_id, current_cases, per_case, date_added)
           VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, CURRENT_TIMESTAMP)) 
           RETURNING id`,
          [godown_id, product_type, productname, brand, brand_id, cases, per_case, customDate]
        );
        stockId = ins.rows[0].id;
      }

      await client.query(
        `INSERT INTO public.stock_history (stock_id, action, cases, per_case_total, added_by, date)
         VALUES ($1, 'added', $2, $3, $4, COALESCE($5, CURRENT_TIMESTAMP))`,
        [stockId, cases, cases * per_case, alloc.added_by || 'Unknown', customDate]
      );

      results.push({ godown_id, productname, brand, cases_added: cases });
    }

    await client.query('COMMIT');
    res.status(201).json({
      message: 'Bulk allocation completed',
      added: results.length,
      details: results
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('bulkAllocate error:', err.message);
    res.status(500).json({ message: 'Failed to allocate stock' });
  } finally {
    client.release();
  }
};

exports.deleteStockEntry = async (req, res) => {
  const client = await pool.connect();
  try {
    const { godown_id, stock_id } = req.params;

    await client.query('BEGIN');

    const ownershipCheck = await client.query(
      'SELECT id FROM public.stock WHERE id = $1 AND godown_id = $2',
      [stock_id, godown_id]
    );

    if (ownershipCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Stock does not belong to this godown or does not exist' });
    }

    await client.query(
      'DELETE FROM public.stock_history WHERE stock_id = $1',
      [stock_id]
    );

    const deleteResult = await client.query(
      'DELETE FROM public.stock WHERE id = $1 RETURNING id',
      [stock_id]
    );

    if (deleteResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Stock entry not found' });
    }

    await client.query('COMMIT');
    res.status(200).json({ message: 'Stock entry and its history deleted successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error in deleteStockEntry:', err.message);
    res.status(500).json({ message: 'Failed to delete stock entry', error: err.message });
  } finally {
    client.release();
  }
};

exports.transferStock = async (req, res) => {
  const client = await pool.connect();
  try {
    const { source_stock_id, target_godown_id, cases_transferred, transfer_date, added_by } = req.body;

    if (!source_stock_id || !target_godown_id || !cases_transferred || parseInt(cases_transferred) <= 0) {
      return res.status(400).json({ message: 'Invalid input' });
    }

    if (!added_by) {
      return res.status(400).json({ message: 'Added by (username) is required' });
    }

    await client.query('BEGIN');

    // ─── Get source stock ───────────────────────────────────────────────
    const sourceStockRes = await client.query(
      `SELECT s.*, g.name as godown_name
       FROM public.stock s
       JOIN public.godown g ON s.godown_id = g.id
       WHERE s.id = $1 FOR UPDATE`,
      [source_stock_id]
    );

    if (sourceStockRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Source stock not found' });
    }

    const source = sourceStockRes.rows[0];

    if (parseInt(cases_transferred) > source.current_cases) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Insufficient cases' });
    }

    const newCurrent = source.current_cases - parseInt(cases_transferred);
    const newTaken = (source.taken_cases || 0) + parseInt(cases_transferred);
    const customDate = transfer_date || null;

    // Update source stock
    await client.query(
      `UPDATE public.stock 
       SET current_cases = $1, taken_cases = $2, last_taken_date = COALESCE($3, CURRENT_TIMESTAMP)
       WHERE id = $4`,
      [newCurrent, newTaken, customDate, source_stock_id]
    );

    // Get target godown name
    const targetGodownRes = await client.query(
      'SELECT name FROM public.godown WHERE id = $1',
      [target_godown_id]
    );

    if (targetGodownRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Target godown not found' });
    }

    const targetName = targetGodownRes.rows[0].name;
    const perCaseTotal = parseInt(cases_transferred) * source.per_case;

    // ─── History for SOURCE (taken) ─────────────────────────────────────
    await client.query(
      `INSERT INTO public.stock_history 
       (stock_id, action, cases, per_case_total, added_by, customer_name, date)
       VALUES ($1, 'taken', $2, $3, $4, $5, COALESCE($6, CURRENT_TIMESTAMP))`,
      [
        source_stock_id,
        parseInt(cases_transferred),
        perCaseTotal,
        added_by,                                 // who did the transfer
        `TRANSFERRED TO ${targetName.replace(/_/g, ' ').toUpperCase()}`,
        customDate
      ]
    );

    // ─── Target stock logic ─────────────────────────────────────────────
    const existingTarget = await client.query(
      `SELECT id, current_cases FROM public.stock 
       WHERE godown_id = $1 AND product_type = $2 AND productname = $3 AND brand = $4`,
      [target_godown_id, source.product_type, source.productname, source.brand]
    );

    let targetStockId;

    if (existingTarget.rows.length > 0) {
      targetStockId = existingTarget.rows[0].id;
      const newTargetCurrent = existingTarget.rows[0].current_cases + parseInt(cases_transferred);

      await client.query(
        `UPDATE public.stock 
         SET current_cases = $1, date_added = COALESCE($2, CURRENT_TIMESTAMP)
         WHERE id = $3`,
        [newTargetCurrent, customDate, targetStockId]
      );
    } else {
      const formattedBrand = source.brand.toLowerCase().replace(/\s+/g, '_');
      let brandRes = await client.query('SELECT id FROM public.brand WHERE name = $1', [formattedBrand]);

      if (brandRes.rows.length === 0) {
        brandRes = await client.query(
          'INSERT INTO public.brand (name) VALUES ($1) RETURNING id',
          [formattedBrand]
        );
      }

      const brandId = brandRes.rows[0].id;

      const insertRes = await client.query(
        `INSERT INTO public.stock 
         (godown_id, product_type, productname, brand, brand_id, current_cases, per_case, date_added)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, CURRENT_TIMESTAMP))
         RETURNING id`,
        [
          target_godown_id,
          source.product_type,
          source.productname,
          source.brand,
          brandId,
          parseInt(cases_transferred),
          source.per_case,
          customDate
        ]
      );

      targetStockId = insertRes.rows[0].id;
    }

    // ─── History for TARGET (added) ─────────────────────────────────────
    const sourceName = source.godown_name;

    await client.query(
      `INSERT INTO public.stock_history 
       (stock_id, action, cases, per_case_total, added_by, date)
       VALUES ($1, 'added', $2, $3, $4, COALESCE($5, CURRENT_TIMESTAMP))`,
      [
        targetStockId,
        parseInt(cases_transferred),
        perCaseTotal,
        `TRANSFERRED FROM ← ${sourceName.replace(/_/g, ' ').toUpperCase()} by ${added_by}`,
        customDate
      ]
    );

    await client.query('COMMIT');
    res.status(200).json({ message: 'Transfer successful' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error in transferStock:', err.message);
    res.status(500).json({ message: 'Failed to transfer', error: err.message });
  } finally {
    client.release();
  }
};