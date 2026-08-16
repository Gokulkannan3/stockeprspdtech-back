const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
});

exports.addProduct = async (req, res) => {
  try {
    const { productname, brand, hsn_code, price, per_case } = req.body;
    if (!productname || !price || !per_case)
      return res.status(400).json({ message: 'Required fields missing' });

    const dup = await pool.query(
      `SELECT id FROM public.tproductssstable 
       WHERE LOWER(productname) = LOWER($1) AND LOWER(brand) = LOWER($2)`,
      [productname.trim(), (brand || '').trim()]
    );
    if (dup.rows.length) return res.status(400).json({ message: 'Product already exists' });

    const result = await pool.query(
      `INSERT INTO public.tproductssstable 
       (productname, brand, hsn_code, price, per_case)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        productname.trim(),
        brand || null,
        hsn_code || null,
        parseFloat(price),
        parseInt(per_case)
      ]
    );

    res.status(201).json({ message: 'Product added', id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to add product' });
  }
};

exports.getAllProducts = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id, 
        productname, 
        brand, 
        hsn_code, 
        price AS rate_per_box, 
        per_case
      FROM public.tproductssstable 
      ORDER BY productname
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch products' });
  }
};

// ─── Search products from tproductssstable (main inventory master) ─────────────
exports.searchProducts = async (req, res) => {
  const { name } = req.query;
  const searchTerm = `%${(name || '').trim().toLowerCase()}%`;

  try {
    const result = await pool.query(`
      SELECT 
        id,
        productname, 
        brand, 
        hsn_code,
        price AS rate_per_box, 
        per_case
      FROM public.tproductssstable 
      WHERE LOWER(productname) LIKE $1 
         OR LOWER(brand) LIKE $1 
      ORDER BY productname
      LIMIT 30
    `, [searchTerm]);

    res.json(result.rows);
  } catch (err) {
    console.error('Search Products Error:', err);
    res.status(500).json({ message: 'Search failed' });
  }
};

// ─── Check if a product exists in inventory ────────────────────────────────────
exports.checkProductExists = async (req, res) => {
  const { productname, brand } = req.query;
  try {
    const result = await pool.query(
      `SELECT id, productname, brand, price AS rate_per_box, per_case
       FROM public.tproductssstable 
       WHERE LOWER(productname) = LOWER($1) AND LOWER(COALESCE(brand,'')) = LOWER($2)`,
      [productname || '', brand || '']
    );
    res.json({ exists: result.rows.length > 0, product: result.rows[0] || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Check failed' });
  }
};

// ─── Get all product types ─────────────────────────────────────────────────────
exports.getProductTypes = async (req, res) => {
  try {
    // Get from public.products table (product type registry)
    const result = await pool.query(`
      SELECT product_type FROM public.products ORDER BY product_type
    `);
    res.json(result.rows.map(r => r.product_type));
  } catch (err) {
    // If products table doesn't exist yet, return empty
    console.error('getProductTypes error:', err.message);
    res.json([]);
  }
};

// ─── Add products from Purchase Bill to Inventory ─────────────────────────────
// Called after a purchase is created, for new products that weren't in inventory
exports.addFromPurchase = async (req, res) => {
  const client = await pool.connect();
  try {
    const { products } = req.body;
    // products: [{ productname, brand, rate_per_box, per_case, product_type }]
    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ message: 'No products provided' });
    }

    await client.query('BEGIN');

    const added = [];
    const skipped = [];

    for (const p of products) {
      const { productname, brand, rate_per_box, per_case, product_type } = p;
      if (!productname || !product_type) {
        skipped.push({ productname, reason: 'Missing name or product type' });
        continue;
      }

      const pName = productname.trim();
      const bName = (brand || 'General').trim();
      const price = parseFloat(rate_per_box) || 0;
      const perCase = parseInt(per_case) || 1;
      const pType = product_type.toLowerCase().replace(/\s+/g, '_');

      // 1. Add to tproductssstable (main inventory master) if not exists
      try {
        await client.query('SAVEPOINT sp_tprod');
        const dupCheck = await client.query(
          `SELECT id FROM public.tproductssstable 
           WHERE LOWER(productname) = LOWER($1) AND LOWER(COALESCE(brand,'')) = LOWER($2)`,
          [pName, bName]
        );
        if (dupCheck.rows.length === 0) {
          await client.query(
            `INSERT INTO public.tproductssstable (productname, brand, price, per_case) VALUES ($1, $2, $3, $4)`,
            [pName, bName, price, perCase]
          );
        }
        await client.query('RELEASE SAVEPOINT sp_tprod');
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT sp_tprod');
        console.log('tproductssstable insert log:', e.message);
      }

      // 2. Register product_type in public.products table
      try {
        await client.query('SAVEPOINT sp_prodtype');
        await client.query(`
          CREATE TABLE IF NOT EXISTS public.products (
            id SERIAL PRIMARY KEY,
            product_type TEXT NOT NULL,
            CONSTRAINT products_product_type_unique UNIQUE (product_type)
          )
        `);
        await client.query(
          `INSERT INTO public.products (product_type) VALUES ($1) ON CONFLICT (product_type) DO NOTHING`,
          [pType]
        );
        await client.query('RELEASE SAVEPOINT sp_prodtype');
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT sp_prodtype');
      }

      // 3. Add to the product_type-specific table
      try {
        await client.query('SAVEPOINT sp_ptable');
        await client.query(`
          CREATE TABLE IF NOT EXISTS public."${pType}" (
            id BIGSERIAL PRIMARY KEY,
            productname TEXT NOT NULL,
            price NUMERIC(10,2) NOT NULL,
            per_case INTEGER NOT NULL,
            brand TEXT NOT NULL
          )
        `);
        const dupType = await client.query(
          `SELECT id FROM public."${pType}" WHERE LOWER(productname) = LOWER($1) AND LOWER(brand) = LOWER($2)`,
          [pName, bName]
        );
        if (dupType.rows.length === 0) {
          await client.query(
            `INSERT INTO public."${pType}" (productname, price, per_case, brand) VALUES ($1, $2, $3, $4)`,
            [pName, price, perCase, bName]
          );
        }
        await client.query('RELEASE SAVEPOINT sp_ptable');
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT sp_ptable');
        console.log('product type table insert log:', e.message);
      }

      added.push({ productname: pName, brand: bName, product_type: pType });
    }

    await client.query('COMMIT');
    res.json({ success: true, added, skipped });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('addFromPurchase error:', err);
    res.status(500).json({ message: 'Failed to add products to inventory' });
  } finally {
    client.release();
  }
};

exports.updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const { productname, brand, hsn_code, price, per_case } = req.body;

    if (!productname || !price || !per_case)
      return res.status(400).json({ message: 'Required fields missing' });

    await pool.query(
      `UPDATE public.tproductssstable 
       SET productname = $1, 
           brand = $2, 
           hsn_code = $3, 
           price = $4, 
           per_case = $5
       WHERE id = $6`,
      [
        productname.trim(),
        brand || null,
        hsn_code || null,
        parseFloat(price),
        parseInt(per_case),
        id
      ]
    );
    res.json({ message: 'Product updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Update failed' });
  }
};

exports.deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM public.tproductssstable WHERE id = $1`, [id]);
    res.json({ message: 'Product deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Delete failed' });
  }
};

exports.getStates = async (req, res) => {
  try {
    const result = await pool.query('SELECT code, state_name FROM codestate ORDER BY code');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch states' });
  }
};