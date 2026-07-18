import shutil
from pathlib import Path

from PIL import Image, ImageChops


SOURCE_DIR = Path("jee_main_pyq_images/media/upload")
FINAL_DIR = Path("final_images")
RASTER_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
COPY_EXTENSIONS = {".svg"}


def remove_light_watermark(img):
    """Remove faint light/blue watermark pixels while keeping dark diagram content."""
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        r, g, b, a = rgba.split()
        rgb = Image.merge("RGB", (r, g, b))
        rgb = whiten_light_blue_pixels(rgb)

        low_alpha_mask = a.point(lambda p: 255 if p < 120 else 0)
        a = a.copy()
        a.paste(0, mask=low_alpha_mask)
        rgb.putalpha(a)
        return rgb

    return whiten_light_blue_pixels(img.convert("RGB"))


def mask_and(*masks):
    mask = masks[0]
    for next_mask in masks[1:]:
        mask = ImageChops.multiply(mask, next_mask)
    return mask


def mask_or(*masks):
    mask = masks[0]
    for next_mask in masks[1:]:
        mask = ImageChops.lighter(mask, next_mask)
    return mask


def whiten_light_blue_pixels(img):
    r, g, b = img.split()

    high_r = r.point(lambda p: 255 if p > 175 else 0)
    high_g = g.point(lambda p: 255 if p > 175 else 0)
    high_b = b.point(lambda p: 255 if p > 175 else 0)
    blue_over_r = ImageChops.subtract(b, r).point(lambda p: 255 if p > 8 else 0)
    blue_over_g = ImageChops.subtract(b, g).point(lambda p: 255 if p > 4 else 0)

    watermark_mask = mask_and(
        high_r,
        high_g,
        high_b,
        mask_or(blue_over_r, blue_over_g),
    )

    cleaned = img.copy()
    cleaned.paste((255, 255, 255), mask=watermark_mask)
    return cleaned


def clean_raster(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source) as img:
        cleaned = remove_light_watermark(img)
        save_kwargs = {}
        if destination.suffix.lower() in {".jpg", ".jpeg"}:
            cleaned = cleaned.convert("RGB")
            save_kwargs.update({"quality": 95, "optimize": True})
        elif destination.suffix.lower() == ".webp":
            save_kwargs.update({"quality": 95, "method": 6})
        cleaned.save(destination, **save_kwargs)


def copy_file(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def main():
    if not SOURCE_DIR.exists():
        raise FileNotFoundError(f"Source folder not found: {SOURCE_DIR}")

    processed = 0
    copied = 0
    failed = []

    for source in sorted(SOURCE_DIR.rglob("*")):
        if not source.is_file():
            continue

        rel_path = source.relative_to(SOURCE_DIR)
        destination = FINAL_DIR / rel_path
        ext = source.suffix.lower()

        try:
            if ext in RASTER_EXTENSIONS:
                clean_raster(source, destination)
                processed += 1
            elif ext in COPY_EXTENSIONS:
                copy_file(source, destination)
                copied += 1
        except Exception as exc:
            failed.append((str(rel_path), str(exc)))

        total_done = processed + copied + len(failed)
        if total_done and total_done % 500 == 0:
            print(f"Completed {total_done} files...", flush=True)

    print(f"Raster images cleaned: {processed}")
    print(f"SVG files copied unchanged: {copied}")
    print(f"Failed files: {len(failed)}")

    if failed:
        failure_log = FINAL_DIR / "failed-watermark-cleaning.txt"
        failure_log.parent.mkdir(parents=True, exist_ok=True)
        failure_log.write_text(
            "\n".join(f"{path}: {error}" for path, error in failed) + "\n"
        )
        print(f"Failure log: {failure_log}")


if __name__ == "__main__":
    main()
