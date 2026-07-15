import os
from PIL import Image

def clean_file(filepath):
    # Open the image
    img = Image.open(filepath)
    orig_mode = img.mode
    img_format = img.format
    
    # Check if the image has alpha channel or palette with transparency
    has_alpha = False
    if img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info):
        has_alpha = True
        
    if has_alpha:
        img = img.convert('RGBA')
        pixels = img.load()
        width, height = img.size
        for y in range(height):
            for x in range(width):
                r, g, b, a = pixels[x, y]
                # Filter out low opacity watermark pixels
                if a < 120:
                    pixels[x, y] = (0, 0, 0, 0)
        img.save(filepath, format=img_format)
        print(f"Processed Transparent PNG image {os.path.basename(filepath)} (Mode: {orig_mode} -> RGBA)")
    else:
        img = img.convert('RGB')
        pixels = img.load()
        width, height = img.size
        for y in range(height):
            for x in range(width):
                r, g, b = pixels[x, y]
                # Watermark is very light (high R, G, B) and has a blue tint (B > R + 8 or B > G + 4)
                if r > 180 and g > 180 and b > 180:
                    if b > r + 8 or b > g + 4:
                        pixels[x, y] = (255, 255, 255)
        img.save(filepath, format=img_format)
        print(f"Processed RGB/WebP image {os.path.basename(filepath)} (Mode: {orig_mode} -> RGB)")

def clean_directory(dirpath):
    print(f"Starting cleanup in: {dirpath}")
    count = 0
    for root, dirs, files in os.walk(dirpath):
        for file in files:
            ext = os.path.splitext(file)[1].lower()
            if ext in ('.png', '.webp'):
                filepath = os.path.join(root, file)
                try:
                    clean_file(filepath)
                    count += 1
                except Exception as e:
                    print(f"Error processing {file}: {e}")
    print(f"Cleanup finished. Total files processed: {count}")

if __name__ == '__main__':
    target_dir = '/Users/pc/Downloads/jee_main_pyq_images/media/upload/jee_main_2026_online_8th_april_evening_shift'
    clean_directory(target_dir)
