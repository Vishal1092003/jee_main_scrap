import json
import re
import shutil
from pathlib import Path


UPLOAD_DIR = Path("media/upload")
MANIFEST_DATA_JS = Path("manifest-data.js")
IMAGE_RE = re.compile(
    r"^(?P<paper>.+)_q(?P<question>\d{3})_"
    r"(?P<kind>question|explanation|option_[A-D])_img(?P<image>\d{2})\.(?P<ext>png|webp)$",
    re.IGNORECASE,
)


def category_for(kind):
    if kind == "question":
        return "question"
    if kind == "explanation":
        return "explanation"
    if kind.startswith("option_"):
        return "option_img"
    raise ValueError(f"Unknown image kind: {kind}")


def local_url_for(paper, file_name):
    match = IMAGE_RE.match(file_name)
    if not match:
        return None

    category = category_for(match.group("kind").lower())
    return f"/media/upload/{paper}/{category}/{file_name}"


def move_images(shift_dir):
    moved = 0
    skipped = 0

    for path in sorted(shift_dir.rglob("*")):
        if not path.is_file():
            continue

        match = IMAGE_RE.match(path.name)
        if not match:
            skipped += 1
            continue

        category = category_for(match.group("kind").lower())
        destination = shift_dir / category / path.name

        if path.resolve() == destination.resolve():
            continue

        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            raise FileExistsError(f"Destination already exists: {destination}")

        shutil.move(str(path), str(destination))
        moved += 1

    return moved, skipped


def update_image_manifest(shift_dir):
    manifest_path = shift_dir / "image-manifest.json"
    if not manifest_path.exists():
        return None

    manifest = json.loads(manifest_path.read_text())
    paper = manifest["paper"]

    for image in manifest.get("images", []):
        new_url = local_url_for(paper, image["fileName"])
        if new_url:
            image["localUrl"] = new_url

    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def update_manifest_data_js(manifest):
    if not manifest or not MANIFEST_DATA_JS.exists():
        return False

    MANIFEST_DATA_JS.write_text(
        "window.MANIFEST_DATA = "
        + json.dumps(manifest, ensure_ascii=False)
        + ";\n"
    )
    return True


def main():
    if not UPLOAD_DIR.exists():
        raise FileNotFoundError(f"Upload directory not found: {UPLOAD_DIR}")

    total_moved = 0
    updated_manifests = 0

    for shift_dir in sorted(path for path in UPLOAD_DIR.iterdir() if path.is_dir()):
        moved, _ = move_images(shift_dir)
        manifest = update_image_manifest(shift_dir)
        if manifest:
            updated_manifests += 1
            update_manifest_data_js(manifest)
        total_moved += moved

    print(f"Moved image files: {total_moved}")
    print(f"Updated image manifests: {updated_manifests}")


if __name__ == "__main__":
    main()
