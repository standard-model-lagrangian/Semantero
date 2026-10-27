import hashlib
import re
import shutil
import sqlite3
import sys
import tempfile
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path


def db_files(zotero_dir: Path) -> list[Path]:
    """zotero.sqlite and its write-ahead log. Zotero runs in WAL mode: new items sit in zotero.sqlite-wal, often for
    hours, until a checkpoint copies them into zotero.sqlite, so anything that watches or reads the library needs both."""
    return [zotero_dir / "zotero.sqlite", zotero_dir / "zotero.sqlite-wal"]


def _stamp(p: Path) -> tuple[int, int] | None:
    try:
        st = p.stat()
        return st.st_mtime_ns, st.st_size
    except FileNotFoundError:
        return None


@contextmanager
def open_snapshot(zotero_dir: Path | str) -> Iterator[sqlite3.Connection]:
    """A connection to a private copy of the library, write-ahead log included. Zotero holds the database in
    exclusive locking mode, so it can't be opened in place: `?immutable=1` reads only zotero.sqlite and misses
    everything since the last checkpoint. The log is copied before and after the database and the copy retried if it
    moved, so a checkpoint during the copy can't pair an old log with a newer database."""
    zotero_dir = Path(zotero_dir).expanduser()
    db, wal = db_files(zotero_dir)
    if not db.exists():
        raise FileNotFoundError(f"Zotero database not found: {db}")
    with tempfile.TemporaryDirectory(prefix="planner-zotero-") as tmp:
        copy_db, copy_wal = Path(tmp) / db.name, Path(tmp) / wal.name
        for attempt in range(3):
            copy_wal.unlink(missing_ok=True)
            before = _stamp(wal)
            if before is not None:
                shutil.copyfile(wal, copy_wal)
            shutil.copyfile(db, copy_db)
            if _stamp(wal) == before:
                break
            time.sleep(0.2 * (attempt + 1))
        # Read-write on purpose: opening the copy replays its log into it (read-only can't without a -shm file).
        conn = sqlite3.connect(copy_db)
        try:
            yield conn
        finally:
            conn.close()


@dataclass
class PdfAttachment:
    attachmentKey: str
    path: Path
    pages: int = 0
    hasText: bool = True
    file: str | None = None  # relative to <zotero>/storage, or absolute for a linked file

    def to_dict(self):
        d = {
            "attachmentKey": self.attachmentKey,
            "pages": self.pages,
            "hasText": self.hasText,
        }
        if self.file:
            d["file"] = self.file
        return d


@dataclass
class SnapshotAttachment:
    """A web snapshot (text/html attachment). It has no pages; its chunks carry page 0."""
    attachmentKey: str
    path: Path
    pages: int = 0
    hasText: bool = True
    file: str | None = None

    def to_dict(self):
        d = {
            "attachmentKey": self.attachmentKey,
            "hasText": self.hasText,
        }
        if self.file:
            d["file"] = self.file
        return d


def attachment_path(zotero_dir: Path, att_key: str, path_str: str | None) -> Path | None:
    if path_str and path_str.startswith("storage:"):
        return zotero_dir / "storage" / att_key / path_str[len("storage:"):]
    if path_str:
        return Path(path_str)
    return None


def attachment_file(att_key: str, path_str: str | None) -> str | None:
    """The `file` recorded in papers.json: storage-relative for stored files, absolute for linked ones."""
    if path_str and path_str.startswith("storage:"):
        return f"{att_key}/{path_str[len('storage:'):]}"
    if path_str:
        return str(Path(path_str))
    return None


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
    snapshots: list[SnapshotAttachment] = field(default_factory=list)

    def attachments(self) -> list[PdfAttachment | SnapshotAttachment]:
        return [*self.pdfs, *self.snapshots]

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
            "snapshots": [s.to_dict() for s in self.snapshots],
            "abstractRow": abstract_row,
        }


def _extract_year(date_str: str | None) -> int | None:
    if not date_str:
        return None
    m = re.search(r"\b(\d{4})\b", date_str)
    return int(m.group(1)) if m else None


def read_library(zotero_dir: Path | str) -> list[Paper]:
    """Read regular items from Zotero library via a private copy (open_snapshot)."""
    zotero_dir = Path(zotero_dir).expanduser()
    with open_snapshot(zotero_dir) as conn:
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

        # 9. Load PDF and web-snapshot attachments (children only; standalone ones have no paper)
        cur.execute("""
            SELECT a.itemID, i.key, a.parentItemID, a.path, a.contentType
            FROM itemAttachments a
            JOIN items i ON a.itemID = i.itemID
            WHERE a.contentType IN ('application/pdf', 'text/html')
              AND a.itemID NOT IN (SELECT itemID FROM deletedItems)
        """)
        pdfs_by_parent: dict[int, list[PdfAttachment]] = {}
        snapshots_by_parent: dict[int, list[SnapshotAttachment]] = {}
        for att_id, att_key, parent_id, path_str, content_type in cur.fetchall():
            if not parent_id:
                continue
            full_path = attachment_path(zotero_dir, att_key, path_str)
            if full_path is None:
                continue
            if content_type == "text/html":
                snapshots_by_parent.setdefault(parent_id, []).append(
                    SnapshotAttachment(attachmentKey=att_key, path=full_path, file=attachment_file(att_key, path_str))
                )
            else:
                pdfs_by_parent.setdefault(parent_id, []).append(
                    PdfAttachment(attachmentKey=att_key, path=full_path, file=attachment_file(att_key, path_str))
                )

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
            snapshots = snapshots_by_parent.get(item_id, [])

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
                    snapshots=snapshots,
                )
            )

        return papers


def compute_fingerprint(zotero_dir: Path | str) -> str | None:
    zotero_dir = Path(zotero_dir).expanduser()
    db_path = zotero_dir / "zotero.sqlite"
    if not db_path.exists():
        return None

    try:
        with open_snapshot(zotero_dir) as conn:
            return _fingerprint(conn, zotero_dir)
    except Exception as e:
        print(f"zotero fingerprint: sqlite unreadable ({e})", file=sys.stderr, flush=True)
        return None


def _fingerprint(conn: sqlite3.Connection, zotero_dir: Path) -> str:
    """Items, edits and every PDF/snapshot attachment's path, size and mtime."""
    cur = conn.cursor()

    # 1. number of regular items not in the trash
    cur.execute("""
        SELECT COUNT(*) FROM items
        WHERE itemID NOT IN (SELECT itemID FROM deletedItems)
          AND itemTypeID NOT IN (
              SELECT itemTypeID FROM itemTypes
              WHERE typeName IN ('attachment', 'note', 'annotation')
          )
    """)
    regular_count = cur.fetchone()[0]

    # 2. max(clientDateModified) over items
    cur.execute("""
        SELECT MAX(clientDateModified) FROM items
        WHERE itemID NOT IN (SELECT itemID FROM deletedItems)
    """)
    max_client_date = cur.fetchone()[0] or ""

    # 3. number of PDF and web-snapshot attachments
    cur.execute("""
        SELECT COUNT(*) FROM itemAttachments
        WHERE itemID NOT IN (SELECT itemID FROM deletedItems)
          AND contentType IN ('application/pdf', 'text/html')
    """)
    att_count = cur.fetchone()[0]

    # 4. sorted list of (path, mtime, size) for each PDF or snapshot attachment
    cur.execute("""
        SELECT i.key, a.path
        FROM itemAttachments a
        JOIN items i ON a.itemID = i.itemID
        WHERE a.contentType IN ('application/pdf', 'text/html')
          AND a.itemID NOT IN (SELECT itemID FROM deletedItems)
    """)
    pdf_rows = cur.fetchall()

    pdf_stats: list[tuple[str, int, int]] = []
    for att_key, path_str in pdf_rows:
        full_path = attachment_path(zotero_dir, att_key, path_str)
        if full_path is None:
            continue

        if full_path.exists():
            stat = full_path.stat()
            pdf_stats.append((str(full_path), stat.st_mtime_ns, stat.st_size))
        else:
            pdf_stats.append((str(full_path), 0, 0))

    pdf_stats.sort(key=lambda x: x[0])

    hasher = hashlib.sha256()
    hasher.update(f"reg:{regular_count}".encode())
    hasher.update(f"max_date:{max_client_date}".encode())
    hasher.update(f"att:{att_count}".encode())
    for p, m, s in pdf_stats:
        hasher.update(f"{p}:{m}:{s}".encode())

    return hasher.hexdigest()
