# Alice reader

A small reading app for a graded German reader (levels A1 to B2). It runs in the browser, can be added to the iPhone Home Screen and works offline.

## What it does

- Shows the chapters of a book file that you load on your phone from the Files app.
- Tap any word: basic form, article and plural for nouns, level, English meaning, the sentence, and read aloud.
- Saves your reading position, finished chapters, saved and known words, reading minutes and day streak.
- Backup and restore of your progress as one file (Settings).

## Privacy

The book file and all progress stay on the phone (IndexedDB). This repository contains only the app code, not the book. Nothing is sent to a server.

## Install on iPhone

1. Open the site in Safari.
2. Tap Share, then Add to Home Screen, then Add.
3. Open the app from the new icon and load the book file there. Safari and the installed app keep separate storage.

## Files

| File | Purpose |
| --- | --- |
| index.html | page shell |
| app.js | the app |
| db.js | storage on the phone (IndexedDB) |
| styles.css | design |
| sw.js | offline cache (service worker) |
| manifest.webmanifest, icon-*.png | Home Screen app name and icons |

## Update

Upload the changed files to this repository again. The app shows "A new version of the app is ready" and reloads after you tap Reload. Progress on the phone is kept.
