import sys
import json

def detect_face(image_path):
    try:
        import cv2
        img = cv2.imread(image_path)
        if img is None:
            return {"found": False, "reason": "could not read image"}

        h, w = img.shape[:2]
        if h <= 0 or w <= 0:
            return {"found": False, "reason": "invalid image dimensions"}
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        # Multi-scale cascade with lower threshold for small streamer faces
        cascade_files = [
            'haarcascade_frontalface_default.xml',
            'haarcascade_frontalface_alt2.xml',
        ]

        faces = []
        for cname in cascade_files:
            cas_path = getattr(cv2.data, 'haarcascades', '') + cname
            cascade = cv2.CascadeClassifier(cas_path)
            detected = cascade.detectMultiScale(gray, scaleFactor=1.05, minNeighbors=3, minSize=(25, 25))
            if len(detected) > 0:
                faces.extend(detected)
                break

        if len(faces) == 0:
            return {"found": False}

        # In gaming streams, streamer facecam is located near corners/edges.
        # Prefer faces further away from exact center of the screen.
        def edge_score(f):
            fx, fy, fw, fh = f
            cx, cy = fx + fw / 2, fy + fh / 2
            dist_from_center = abs(cx - w / 2) / (w / 2) + abs(cy - h / 2) / (h / 2)
            return dist_from_center * 2 + ((fw * fh) / (w * h))

        faces = sorted(faces, key=edge_score, reverse=True)
        x, y, fw, fh = faces[0]

        # Determine quadrant
        mid_x, mid_y = x + fw / 2, y + fh / 2
        is_left = mid_x < (w / 2)
        is_top = mid_y < (h / 2)

        corner = ("top" if is_top else "bottom") + "-" + ("left" if is_left else "right")

        # Calculate ideal 1080:720 (1.5 aspect ratio) crop around streamer facecam
        # Streamer webcam is usually ~25-32% of screen width
        cam_w = max(int(w * 0.28), int(fw * 3.5))
        cam_w = min(cam_w, int(w * 0.40), w)
        cam_h = int(cam_w * (720 / 1080)) # Maintain exact 1080:720 aspect ratio!
        if cam_h > h:
            cam_h = h
            cam_w = max(1, min(w, int(cam_h * (1080 / 720))))

        cx = int(x + fw / 2)
        cy = int(y + fh / 2)
        crop_x = cx - cam_w // 2
        crop_y = cy - cam_h // 2

        # Snap to edges if face is close to screen border
        if is_left and crop_x < (w * 0.08):
            crop_x = 0
        elif not is_left and (crop_x + cam_w) > (w * 0.92):
            crop_x = w - cam_w

        if is_top and crop_y < (h * 0.08):
            crop_y = 0
        elif not is_top and (crop_y + cam_h) > (h * 0.92):
            crop_y = h - cam_h

        crop_x = max(0, min(w - cam_w, crop_x))
        crop_y = max(0, min(h - cam_h, crop_y))

        return {
            "found": True,
            "x": int(x),
            "y": int(y),
            "w": int(fw),
            "h": int(fh),
            "corner": corner,
            "crop_x": int(crop_x),
            "crop_y": int(crop_y),
            "crop_w": int(cam_w),
            "crop_h": int(cam_h),
            "img_width": w,
            "img_height": h
        }
    except Exception as e:
        return {"found": False, "error": str(e)}

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({"found": False, "error": "no image path provided"}))
        sys.exit(1)
    result = detect_face(sys.argv[1])
    print(json.dumps(result))
