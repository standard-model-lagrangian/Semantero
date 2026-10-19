import sqlite3
from pathlib import Path


def create_minimal_zotero_db(db_path: Path):
    db_path.parent.mkdir(parents=True, exist_ok=True)
    if db_path.exists():
        db_path.unlink()

    conn = sqlite3.connect(str(db_path))
    cur = conn.cursor()

    cur.executescript("""
    CREATE TABLE itemTypes (
        itemTypeID INTEGER PRIMARY KEY,
        typeName TEXT,
        templateItemTypeID INTEGER,
        display INTEGER
    );

    INSERT INTO itemTypes VALUES (1, 'annotation', NULL, 0);
    INSERT INTO itemTypes VALUES (2, 'journalArticle', NULL, 1);
    INSERT INTO itemTypes VALUES (3, 'attachment', NULL, 0);
    INSERT INTO itemTypes VALUES (28, 'note', NULL, 0);

    CREATE TABLE fields (
        fieldID INTEGER PRIMARY KEY,
        fieldName TEXT,
        fieldFormatID INTEGER
    );

    INSERT INTO fields VALUES (1, 'title', 0);
    INSERT INTO fields VALUES (2, 'abstractNote', 0);
    INSERT INTO fields VALUES (6, 'date', 0);
    INSERT INTO fields VALUES (8, 'DOI', 0);
    INSERT INTO fields VALUES (9, 'citationKey', 0);
    INSERT INTO fields VALUES (41, 'publicationTitle', 0);

    CREATE TABLE items (
        itemID INTEGER PRIMARY KEY,
        itemTypeID INTEGER,
        dateAdded TEXT,
        dateModified TEXT,
        clientDateModified TEXT,
        libraryID INTEGER,
        key TEXT,
        version INTEGER,
        synced INTEGER
    );

    CREATE TABLE itemDataValues (
        valueID INTEGER PRIMARY KEY AUTOINCREMENT,
        value TEXT UNIQUE
    );

    CREATE TABLE itemData (
        itemID INTEGER,
        fieldID INTEGER,
        valueID INTEGER,
        PRIMARY KEY (itemID, fieldID)
    );

    CREATE TABLE creators (
        creatorID INTEGER PRIMARY KEY AUTOINCREMENT,
        firstName TEXT,
        lastName TEXT,
        fieldMode INTEGER
    );

    CREATE TABLE itemCreators (
        itemID INTEGER,
        creatorID INTEGER,
        creatorTypeID INTEGER,
        orderIndex INTEGER,
        PRIMARY KEY (itemID, creatorID, orderIndex)
    );

    CREATE TABLE collections (
        collectionID INTEGER PRIMARY KEY AUTOINCREMENT,
        collectionName TEXT,
        parentCollectionID INTEGER,
        clientDateModified TEXT,
        libraryID INTEGER,
        key TEXT,
        version INTEGER,
        synced INTEGER
    );

    CREATE TABLE collectionItems (
        collectionID INTEGER,
        itemID INTEGER,
        orderIndex INTEGER,
        PRIMARY KEY (collectionID, itemID)
    );

    CREATE TABLE tags (
        tagID INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE
    );

    CREATE TABLE itemTags (
        itemID INTEGER,
        tagID INTEGER,
        type INTEGER,
        PRIMARY KEY (itemID, tagID)
    );

    CREATE TABLE itemAttachments (
        itemID INTEGER PRIMARY KEY,
        parentItemID INTEGER,
        linkMode INTEGER,
        contentType TEXT,
        charsetID INTEGER,
        path TEXT,
        syncState INTEGER,
        storageModTime INTEGER,
        storageHash TEXT,
        lastProcessedModificationTime INTEGER,
        lastRead INTEGER
    );

    CREATE TABLE deletedItems (
        itemID INTEGER PRIMARY KEY,
        dateDeleted TEXT
    );
    """)

    def get_or_create_val(val: str) -> int:
        cur.execute("SELECT valueID FROM itemDataValues WHERE value = ?", (val,))
        row = cur.fetchone()
        if row:
            return row[0]
        cur.execute("INSERT INTO itemDataValues (value) VALUES (?)", (val,))
        return cur.lastrowid

    def set_field(item_id: int, field_name: str, val: str):
        cur.execute("SELECT fieldID FROM fields WHERE fieldName = ?", (field_name,))
        fid = cur.fetchone()[0]
        vid = get_or_create_val(val)
        cur.execute("INSERT OR REPLACE INTO itemData (itemID, fieldID, valueID) VALUES (?, ?, ?)",
                    (item_id, fid, vid))

    def add_creator(item_id: int, last: str, first: str = "", order: int = 0):
        cur.execute("INSERT INTO creators (firstName, lastName, fieldMode) VALUES (?, ?, 0)", (first, last))
        cid = cur.lastrowid
        cur.execute("INSERT INTO itemCreators (itemID, creatorID, creatorTypeID, orderIndex) VALUES (?, ?, 1, ?)",
                    (item_id, cid, order))

    def add_tag(item_id: int, tag_name: str):
        cur.execute("INSERT OR IGNORE INTO tags (name) VALUES (?)", (tag_name,))
        cur.execute("SELECT tagID FROM tags WHERE name = ?", (tag_name,))
        tid = cur.fetchone()[0]
        cur.execute("INSERT OR REPLACE INTO itemTags (itemID, tagID, type) VALUES (?, ?, 0)", (item_id, tid))

    def add_collection(item_id: int, col_name: str):
        cur.execute("SELECT collectionID FROM collections WHERE collectionName = ?", (col_name,))
        row = cur.fetchone()
        if row:
            cid = row[0]
        else:
            cur.execute("INSERT INTO collections (collectionName) VALUES (?)", (col_name,))
            cid = cur.lastrowid
        cur.execute("INSERT OR REPLACE INTO collectionItems (collectionID, itemID, orderIndex) VALUES (?, ?, 0)",
                    (cid, item_id))

    def add_attachment(att_id: int, parent_id: int, att_key: str, filename: str, content_type: str = "application/pdf"):
        cur.execute("INSERT INTO items (itemID, itemTypeID, key) VALUES (?, 3, ?)", (att_id, att_key))
        cur.execute("""
            INSERT INTO itemAttachments (itemID, parentItemID, contentType, path)
            VALUES (?, ?, ?, ?)
        """, (att_id, parent_id, content_type, f"storage:{filename}"))

    # 1. Ordinary paper with abstract and 1 PDF
    cur.execute("INSERT INTO items (itemID, itemTypeID, key) VALUES (1, 2, 'KEY0001')")
    set_field(1, "title", "Tunable hydrogel viscoelasticity modulates human neural maturation")
    set_field(1, "citationKey", "roth2023tunable")
    set_field(1, "date", "2023-05-01")
    set_field(1, "publicationTitle", "Science Advances")
    set_field(1, "DOI", "10.1126/sciadv.abq7529")
    set_field(1, "abstractNote", "Faster stress relaxation accelerated neuronal maturation and neural network development.")
    add_creator(1, "Roth", "Jane", 0)
    add_creator(1, "Bauer", "L.", 1)
    add_tag(1, "hydrogels")
    add_collection(1, "Biomaterials")
    add_attachment(101, 1, "ATT001", "sample.pdf")

    # 2. Paper without an abstract, with 1 PDF
    cur.execute("INSERT INTO items (itemID, itemTypeID, key) VALUES (2, 2, 'KEY0002')")
    set_field(2, "title", "Next-generation cancer organoids")
    set_field(2, "citationKey", "lesavage2022next")
    set_field(2, "date", "May 2022")
    set_field(2, "publicationTitle", "Nature Materials")
    set_field(2, "DOI", "10.1038/s41563-022-01256-4")
    add_creator(2, "LeSavage", "Bauer L.", 0)
    add_creator(2, "Heilshorn", "Sarah C.", 1)
    add_tag(2, "organoids")
    add_collection(2, "Oncology")
    add_attachment(102, 2, "ATT002", "sample2.pdf")

    # 3. Paper in the trash
    cur.execute("INSERT INTO items (itemID, itemTypeID, key) VALUES (3, 2, 'KEY0003')")
    set_field(3, "title", "Trashed Paper on Gel Degradation")
    set_field(3, "citationKey", "trash2021paper")
    set_field(3, "date", "2021")
    set_field(3, "abstractNote", "This paper is in the trash.")
    add_creator(3, "Smith", "John", 0)
    add_attachment(103, 3, "ATT003", "trashed.pdf")
    cur.execute("INSERT INTO deletedItems (itemID, dateDeleted) VALUES (3, '2026-10-18T10:00:00')")

    # 4. Paper with 2 PDFs
    cur.execute("INSERT INTO items (itemID, itemTypeID, key) VALUES (4, 2, 'KEY0004')")
    set_field(4, "title", "Engineered Matrices and Chemoresistance")
    set_field(4, "citationKey", "wang2024engineered")
    set_field(4, "date", "2024")
    set_field(4, "publicationTitle", "Nature Biomedical Engineering")
    set_field(4, "DOI", "10.1038/s41551-024-01234-x")
    set_field(4, "abstractNote", "Engineered matrices reveal stiffness-mediated chemoresistance in patient-derived pancreatic cancer organoids.")
    add_creator(4, "Wang", "David", 0)
    add_creator(4, "Zhang", "Kevin", 1)
    add_tag(4, "stiffness")
    add_collection(4, "Biomaterials")
    add_attachment(104, 4, "ATT004A", "main.pdf")
    add_attachment(105, 4, "ATT004B", "supp.pdf")

    # 5. Paper with no PDF
    cur.execute("INSERT INTO items (itemID, itemTypeID, key) VALUES (5, 2, 'KEY0005')")
    set_field(5, "title", "Theoretical Models of Cellular Viscoelasticity")
    set_field(5, "citationKey", "johnson2020theoretical")
    set_field(5, "date", "2020-01-15")
    set_field(5, "publicationTitle", "Biophysical Journal")
    set_field(5, "DOI", "10.1016/j.bpj.2020.01.001")
    set_field(5, "abstractNote", "A continuum mechanics approach to cell viscoelasticity without experiment.")
    add_creator(5, "Johnson", "A.", 0)
    add_tag(5, "theory")
    add_collection(5, "Mechanics")

    # A standalone note (excluded)
    cur.execute("INSERT INTO items (itemID, itemTypeID, key) VALUES (6, 28, 'NOTE001')")

    conn.commit()
    conn.close()


if __name__ == "__main__":
    db_out = Path(__file__).parent / "zotero.sqlite"
    create_minimal_zotero_db(db_out)
    print(f"Created {db_out}")
