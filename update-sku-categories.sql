-- Update SKU category and material fields based on CSV mapping
-- material field = process (Tipped, Bladed, Stud Tested, Completed Packs)
-- category field = category (Aluminum, Titanium, Steel, TRUMP, PRACTICE TIPS)

-- Titanium (100g)
UPDATE "skus" SET material = 'Tipped', category = 'Titanium (100g)' WHERE sku = 'TI-100-TIPPED-FERRULE';
UPDATE "skus" SET material = 'Bladed', category = 'Titanium (100g)' WHERE sku = 'TI-2IN-100G-BLADED-FERRULE';
UPDATE "skus" SET material = 'Stud Tested', category = 'Titanium (100g)' WHERE sku = 'TI-2IN-100G-BEAST';
UPDATE "skus" SET material = 'Completed Packs', category = 'Titanium (100g)' WHERE sku = 'TI-3PACK-100g-2.0in';
UPDATE "skus" SET material = 'Bladed', category = 'Titanium (100g)' WHERE sku = 'TI-23IN-100G-BLADED-FERRULE';
UPDATE "skus" SET material = 'Stud Tested', category = 'Titanium (100g)' WHERE sku = 'TI-23IN-100G-BEAST';
UPDATE "skus" SET material = 'Completed Packs', category = 'Titanium (100g)' WHERE sku = 'TI-3PACK-100g-2.3in';

-- Titanium (125g)
UPDATE "skus" SET material = 'Tipped', category = 'Titanium (125g)' WHERE sku = 'TI-TIPPED-FERRULE';
UPDATE "skus" SET material = 'Bladed', category = 'Titanium (125g)' WHERE sku = 'TI-2IN-BLADED-FERRULE';
UPDATE "skus" SET material = 'Stud Tested', category = 'Titanium (125g)' WHERE sku = 'TI-2IN-125G-BEAST';
UPDATE "skus" SET material = 'Completed Packs', category = 'Titanium (125g)' WHERE sku = 'TI-2PACK-125g-2.0in';
UPDATE "skus" SET material = 'Completed Packs', category = 'Titanium (125g)' WHERE sku = 'TI-3PACK-125g-2.0in';
UPDATE "skus" SET material = 'Bladed', category = 'Titanium (125g)' WHERE sku = 'TI-23IN-BLADED-FERRULE';
UPDATE "skus" SET material = 'Stud Tested', category = 'Titanium (125g)' WHERE sku = 'TI-23IN-125G-BEAST';
UPDATE "skus" SET material = 'Completed Packs', category = 'Titanium (125g)' WHERE sku = 'TI-3PACK-125g-2.3in';

-- Aluminum
UPDATE "skus" SET material = 'Tipped', category = 'Aluminum' WHERE sku = 'TIPPED-FERRULE';
UPDATE "skus" SET material = 'Bladed', category = 'Aluminum' WHERE sku = '23IN-BLADED-FERRULE';
UPDATE "skus" SET material = 'Stud Tested', category = 'Aluminum' WHERE sku = '23IN-100G-BEAST';
UPDATE "skus" SET material = 'Completed Packs', category = 'Aluminum' WHERE sku = '2PACK-100g-2.3in';
UPDATE "skus" SET material = 'Completed Packs', category = 'Aluminum' WHERE sku = '3PACK-100g-2.3in';
UPDATE "skus" SET material = 'Stud Tested', category = 'Aluminum' WHERE sku = '23IN-125G-BEAST';
UPDATE "skus" SET material = 'Completed Packs', category = 'Aluminum' WHERE sku = '2PACK-125g-2.3in';
UPDATE "skus" SET material = 'Completed Packs', category = 'Aluminum' WHERE sku = '3PACK-125g-2.3in';
UPDATE "skus" SET material = 'Stud Tested', category = 'Aluminum' WHERE sku = 'D6-23IN-100G-BEAST';
UPDATE "skus" SET material = 'Completed Packs', category = 'Aluminum' WHERE sku = 'D6-3PACK-100g-2.3in';
UPDATE "skus" SET material = 'Stud Tested', category = 'Aluminum' WHERE sku = 'D6-23IN-125G-BEAST';
UPDATE "skus" SET material = 'Completed Packs', category = 'Aluminum' WHERE sku = 'D6-3PACK-125g-2.3in';
UPDATE "skus" SET material = 'Bladed', category = 'Aluminum' WHERE sku = '2IN-BLADED-FERRULE';
UPDATE "skus" SET material = 'Stud Tested', category = 'Aluminum' WHERE sku = '2IN-100G-BEAST';
UPDATE "skus" SET material = 'Completed Packs', category = 'Aluminum' WHERE sku = '2PACK-100g-2.0in';
UPDATE "skus" SET material = 'Completed Packs', category = 'Aluminum' WHERE sku = '3PACK-100g-2.0in';
UPDATE "skus" SET material = 'Stud Tested', category = 'Aluminum' WHERE sku = '2IN-125G-BEAST';
UPDATE "skus" SET material = 'Completed Packs', category = 'Aluminum' WHERE sku = '2PACK-125g-2.0in';
UPDATE "skus" SET material = 'Completed Packs', category = 'Aluminum' WHERE sku = '3PACK-125g-2.0in';
UPDATE "skus" SET material = 'Stud Tested', category = 'Aluminum' WHERE sku = 'D6-2IN-100G-BEAST';
UPDATE "skus" SET material = 'Completed Packs', category = 'Aluminum' WHERE sku = 'D6-3PACK-100g-2.0in';
UPDATE "skus" SET material = 'Stud Tested', category = 'Aluminum' WHERE sku = 'D6-2IN-125G-BEAST';
UPDATE "skus" SET material = 'Completed Packs', category = 'Aluminum' WHERE sku = 'D6-3PACK-125g-2.0in';

-- Steel
UPDATE "skus" SET material = 'Tipped', category = 'Steel' WHERE sku = 'ST-TIPPED-FERRULE';
UPDATE "skus" SET material = 'Bladed', category = 'Steel' WHERE sku = 'ST-2IN-BLADED-FERRULE';
UPDATE "skus" SET material = 'Stud Tested', category = 'Steel' WHERE sku = 'ST-2IN-150G-BEAST';
UPDATE "skus" SET material = 'Completed Packs', category = 'Steel' WHERE sku = '3PACK-150g-2.0in';

-- TRUMP
UPDATE "skus" SET material = 'Tipped', category = 'TRUMP' WHERE sku = 'TR-TIPPED-FERRULE';
UPDATE "skus" SET material = 'Bladed', category = 'TRUMP' WHERE sku = 'TR-2IN-BLADED-FERRULE';
UPDATE "skus" SET material = 'Completed Packs', category = 'TRUMP' WHERE sku = 'TR-2IN-100G-BEAST';
UPDATE "skus" SET material = 'Completed Packs', category = 'TRUMP' WHERE sku = 'TR-2IN-125G-BEAST';
UPDATE "skus" SET material = 'Bladed', category = 'TRUMP' WHERE sku = 'TR-23IN-BLADED-FERRULE';
UPDATE "skus" SET material = 'Completed Packs', category = 'TRUMP' WHERE sku = 'TR-23IN-100G-BEAST';
UPDATE "skus" SET material = 'Completed Packs', category = 'TRUMP' WHERE sku = 'TR-23IN-125G-BEAST';

-- PRACTICE TIPS
UPDATE "skus" SET material = 'Completed Packs', category = 'PRACTICE TIPS' WHERE sku = '3PACK-PT-100G';
UPDATE "skus" SET material = 'Completed Packs', category = 'PRACTICE TIPS' WHERE sku = '3PACK-PT-125G';
