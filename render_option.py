RENDER_OPTIONS = {
    "0": {
        "name": "GPU Super Fast",
        "encoder": "h264_nvenc",
        "preset": "p2",
        "cq": "24"
    },
    "1": {
        "name": "GPU Balanced",
        "encoder": "h264_nvenc",
        "preset": "p4",
        "cq": "23"
    },
    "2": {
        "name": "GPU High Quality",
        "encoder": "h264_nvenc",
        "preset": "p6",
        "cq": "21"
    },
    "3": {
        "name": "CPU Fast Fallback",
        "encoder": "libx264",
        "preset": "ultrafast",
        "crf": "28"
    },
    "4": {
        "name": "CPU Master Quality",
        "encoder": "libx264",
        "preset": "medium",
        "crf": "21"
    }
}
            #  <option value="0">9:16 · Full HD 1080×1920</option>
            #   <option value="1">9:16 · HD 720×1280</option>
            #   <option value="2">16:9 · Full HD 1920×1080</option>
            #   <option value="3">16:9 · 4K 3840×2160</option>

SIZE_OPTIONS = {
    "0": {
        "name": "9:16 · Full HD 1080×1920",
        "width": "1080",
        "height": "1920"
    },
    "1": {
        "name": "9:16 · HD 720×1280",
        "width": "720",
        "height": "1280"
    },
    "2": {
        "name": "16:9 · Full HD 1920×1080",
        "width": "1920",
        "height": "1080"
    },
    "3": {
        "name": "16:9 · 4K 3840×2160",
        "width": "3840",
        "height": "2160"
    }
}
def get_render_option(option_id):
    return RENDER_OPTIONS.get(str(option_id), RENDER_OPTIONS["0"])
def get_size_option(id):
     return SIZE_OPTIONS.get(str(id), RENDER_OPTIONS["0"])
