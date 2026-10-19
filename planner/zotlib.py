import re
import shutil
import sqlite3
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class PdfAttachment:
    attachmentKey: str
    path: Path
    pages: int = 0
    hasText: bool = True

    def to_dict(self):
        return {
            "attachmentKey": self.attachmentKey,
            "pages": self.pages,
            "hasText": self.hasText,
        }


@dataclass
class Paper:
    key: str
    citekey: str
    title: str
    authors: list[str] = field(default_factory=list)
    year: int | None = None
    journal: str | None = None
    doi: str | None = None
    tags: list[str] = field(default_factory=list)
    collections: list[str] = field(default_factory=list)
    abstract: str | None = None
    pdfs: list[PdfAttachment] = field(default_factory=list)

    def to_dict(self, abstract_row: int | None = None):
        return {
            "key": self.key,
            "citekey": self.citekey,
            "title": self.title,
            "authors": self.authors,
            "year": self.year,
            "journal": self.journal,
            "doi": self.doi,
            "tags": self.tags,
            "collections": self.collections,
            "abstract": self.abstract,
            "pdfs": [p.to_dict() for p in self.pdfs],
            "abstractRow": abstract_row,
        }


def _extract_year(date_str: str | None) -> int | None:
    if not date_str:
        return None
    m = re.search(r"\b(\d{4})\b", date_str)
    return int(m.group(1)) if m else None


def read_library(zotero_dir: Path | str) -> list[Paper]:
    """Read regular items from Zotero library via a temporary copy of zotero.sqlite."""
    zotero_dir = Path(zotero_dir).expanduser()
    db_path = zotero_dir / "zotero.sqlite"
    if not db_path.exists():
        raise FileNotFoundError(f"Zotero database not found: {db_path}")

    # Copy to temporary file; retry once after 2s if copy fails
    tmp_file = tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False)
    tmp_path = Path(tmp_file.name)
    tmp_file.close()

    try:
        try:
            shutil.copy2(db_path, tmp_path)
        except Exception as e:
            time.sleep(2.0)
            try:
                shutil.copy2(db_path, tmp_path)
            except Exception as e2:
                raise RuntimeError(f"Failed to copy {db_path} to temporary file: {e2}") from e2

        conn = sqlite3.connect(f"file:{tmp_path.resolve()}?mode=ro", uri=True)
        cur = conn.cursor()

        # 1. Excluded types
        cur.execute("SELECT itemTypeID FROM itemTypes WHERE typeName IN ('attachment', 'note', 'annotation')")
        excluded_type_ids = {row[0] for row in cur.fetchall()}

        # 2. Excluded deleted items
        cur.execute("SELECT itemID FROM deletedItems")
        deleted_ids = {row[0] for row in cur.fetchall()}

        # 3. Regular items
        cur.execute("SELECT itemID, itemTypeID, key FROM items")
        item_rows = cur.fetchall()
        regular_items = [
            (item_id, key)
            for item_id, item_type_id, key in item_rows
            if item_id not in deleted_ids and item_type_id not in excluded_type_ids
        ]

        if not regular_items:
            conn.close()
            return []

        # 4. Field IDs mapping
        cur.execute("SELECT fieldID, fieldName FROM fields WHERE fieldName IN ('title', 'abstractNote', 'date', 'publicationTitle', 'DOI', 'citationKey')")
        field_map = {name: fid for fid, name in cur.fetchall()}

        # 5. Load itemData
        cur.execute("""
            SELECT d.itemID, d.fieldID, v.value
            FROM itemData d
            JOIN itemDataValues v ON d.valueID = v.valueID
        """)
        item_data_by_id: dict[int, dict[int, str]] = {}
        for item_id, fid, val in cur.fetchall():
            item_data_by_id.setdefault(item_id, {})[fid] = val

        # 6. Load creators
        cur.execute("""
            SELECT ic.itemID, c.lastName, c.firstName, c.fieldMode, ic.orderIndex
            FROM itemCreators ic
            JOIN creators c ON ic.creatorID = c.creatorID
            ORDER BY ic.itemID, ic.orderIndex
        """)
        creators_by_id: dict[int, list[str]] = {}
        for item_id, last, first, mode, _ in cur.fetchall():
            name = last or first or ""
            creators_by_id.setdefault(item_id, []).append(name)

        # 7. Load tags
        cur.execute("""
            SELECT it.itemID, t.name
            FROM itemTags it
            JOIN tags t ON it.tagID = t.tagID
        """)
        tags_by_id: dict[int, list[str]] = {}
        for item_id, tname in cur.fetchall():
            tags_by_id.setdefault(item_id, []).append(tname)

        # 8. Load collections
        cur.execute("""
            SELECT ci.itemID, c.collectionName
            FROM collectionItems ci
            JOIN collections c ON ci.collectionID = c.collectionID
        """)
        collections_by_id: dict[int, list[str]] = {}
        for item_id, cname in cur.fetchall():
            collections_by_id.setdefault(item_id, []).append(cname)

        # 9. Load PDF attachments
        cur.execute("""
            SELECT a.itemID, i.key, a.parentItemID, a.path
            FROM itemAttachments a
            JOIN items i ON a.itemID = i.itemID
            WHERE a.contentType = 'application/pdf'
        """)
        pdfs_by_parent: dict[int, list[PdfAttachment]] = {}
        for att_id, att_key, parent_id, path_str in cur.fetchall():
            if not parent_id:
                continue
            if path_str and path_str.startswith("storage:"):
                fname = path_str[len("storage:"):]
                full_path = zotero_dir / "storage" / att_key / fname
            elif path_str:
                full_path = Path(path_str)
            else:
                continue
            pdfs_by_parent.setdefault(parent_id, []).append(
                PdfAttachment(attachmentKey=att_key, path=full_path)
            )

        conn.close()

        papers: list[Paper] = []
        for item_id, key in regular_items:
            fdata = item_data_by_id.get(item_id, {})
            title = fdata.get(field_map.get("title", -1), "")
            citekey = fdata.get(field_map.get("citationKey", -1), "")
            date_val = fdata.get(field_map.get("date", -1))
            year = _extract_year(date_val)
            journal = fdata.get(field_map.get("publicationTitle", -1))
            doi = fdata.get(field_map.get("DOI", -1))
            abstract = fdata.get(field_map.get("abstractNote", -1))

            authors = creators_by_id.get(item_id, [])
            tags = tags_by_id.get(item_id, [])
            collections = collections_by_id.get(item_id, [])
            pdfs = pdfs_by_parent.get(item_id, [])

            papers.append(
                Paper(
                    key=key,
                    citekey=citekey,
                    title=title,
                    authors=authors,
                    year=year,
                    journal=journal,
                    doi=doi,
                    tags=tags,
                    collections=collections,
                    abstract=abstract,
                    pdfs=pdfs,
                )
            )

        return papers

    finally:
        if tmp_path.exists():
            tmp_path.unlink()
