import sys
import json

def detect_face(image_path):
    try:
        import cv2
        img = cv2.imread(image_path)
        if img is None:
            return {"found": False, "reason": "could not read image"}

        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
        faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4, minSize=(60, 60))

        if len(faces) == 0:
            return {"found": False}

        # Pick the largest face detected
        faces = sorted(faces, key=lambda f: f[2] * f[3], reverse=True)
        x, y, w, h = faces[0]
        img_h, img_w = img.shape[:2]

        # Determine which quadrant
        mid_x, mid_y = x + w / 2, y + h / 2
        is_left = mid_x < (img_w / 2)
        is_top = mid_y < (img_h / 2)

        if is_left and is_top:
            corner = "top-left"
        elif not is_left and is_top:
            corner = "top-right"
        elif is_left and not is_top:
            corner = "bottom-left"
        else:
            corner = "bottom-right"

        return {
            "found": True,
            "x": int(x),
            "y": int(y),
            "w": int(w),
            "h": int(h),
            "corner": corner,
            "img_width": img_w,
            "img_height": img_h
        }
    except Exception as e:
        return {"found": False, "error": str(e)}

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({"found": False, "error": "no image path provided"}))
        sys.exit(1)
    result = detect_face(sys.argv[1])
    print(json.dumps(result))
