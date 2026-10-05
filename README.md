# Protected HLS Downloader Extension

An extension for detecting, organizing, and downloading HLS/M3U8 video streams from supported webpages.

> This project was created for educational and learning purposes to understand HLS streaming, browser networking, Chrome extensions, and media downloading. It is not intended to bypass DRM, authentication, subscriptions, paywalls, or other access restrictions.

## Screenshot

![Protected HLS Downloader Extension](assets/1screenshot.png)

## Features

- Detects HLS/M3U8 video streams
- Automatically selects the best available quality
- Orders detected videos based on webpage position
- Downloads HLS segments in parallel
- Continues downloading when the popup is closed
- Shows live download progress
- Supports multiple video downloads

## How It Works

```text
Webpage
   ↓
HLS / Media Requests
   ↓
M3U8 Detection
   ↓
Best Quality Selection
   ↓
Segment Downloading
   ↓
Video Merge
   ↓
Saved Video File
```

## Important Notice

This project is made only for **educational, learning, development, and testing purposes**.

It is **not intended to bypass DRM, authentication, subscriptions, paywalls, copyright protections, or other security/access restrictions**.

Only download media that you have permission or legal rights to save.

If you use this repository, project, or any part of its code, you do so **at your own risk**. The author will not be responsible for any damage, loss, copyright issue, account issue, policy violation, legal issue, or other consequences resulting from the use or misuse of this project.

Users are responsible for following the rules, terms, and copyright policies of the websites and content they access.

If you believe anything in this repository is inappropriate or should be removed, please kindly contact:

**Email:** dineshsinghdhamidsd@gmail.com

Valid removal requests will be reviewed respectfully.

## Tech Stack

- JavaScript
- HTML
- CSS
- Chrome Extension APIs
- Manifest V3
- HLS / M3U8
- Chrome Web Request APIs
- Chrome Downloads API

## Installation

```bash
git clone https://github.com/dineshsinghdhami/protected-hls-downloader-extension.git
cd protected-hls-downloader-extension
```

Open:

```text
Browser://extensions/
```

Then:

1. Enable **Developer mode**
2. Click **Load unpacked**
3. Select the extension folder
4. Open a supported webpage containing HLS video
5. Play the video briefly
6. Open the extension
7. Select the video you want to download

## Current Limitations

- Mainly supports HLS/M3U8 streams
- DRM-protected media is not supported
- Some websites may not be detected
- Some streams may require additional remuxing
- Websites may change their player implementation at any time

## Author

**Dinesh Singh Dhami**

GitHub: [github.com/dineshsinghdhami](https://github.com/dineshsinghdhami)
