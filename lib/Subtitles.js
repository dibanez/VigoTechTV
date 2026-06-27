// VigoTechTV - Subtitles
// Pure helpers to turn timestamped transcript cues into .srt / .vtt subtitle files.
// A "cue" is { start: <seconds>, end: <seconds>, text: <string> }.

var Subtitles = {
    // Cleans cues: trims text, drops empties, guarantees end > start and no overlap.
    sanitize: function(cues) {
        var clean = [];
        (cues || []).forEach(function(cue) {
            var text = (cue.text || '').trim();
            if (!text) return;

            var start = cue.start > 0 ? cue.start : 0;
            var end = cue.end > start ? cue.end : start + 1.5;

            // Avoid overlapping the previous cue.
            if (clean.length) {
                var prev = clean[clean.length - 1];
                if (start < prev.end) start = prev.end;
                if (end <= start) end = start + 1.5;
            }

            clean.push({ start: start, end: end, text: text });
        });
        return clean;
    },

    // seconds -> "HH:MM:SS,mmm" (srt, comma) or "HH:MM:SS.mmm" (vtt, dot)
    formatTimestamp: function(seconds, useComma) {
        if (!(seconds > 0)) seconds = 0;
        var ms = Math.floor((seconds - Math.floor(seconds)) * 1000);
        var total = Math.floor(seconds);
        var s = total % 60;
        var m = Math.floor(total / 60) % 60;
        var h = Math.floor(total / 3600);

        function pad(n, len) {
            n = '' + n;
            while (n.length < len) n = '0' + n;
            return n;
        }

        var sep = useComma ? ',' : '.';
        return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + sep + pad(ms, 3);
    },

    buildSRT: function(cues) {
        var clean = Subtitles.sanitize(cues);
        var out = '';
        clean.forEach(function(cue, i) {
            out += (i + 1) + '\n';
            out += Subtitles.formatTimestamp(cue.start, true) + ' --> ' +
                   Subtitles.formatTimestamp(cue.end, true) + '\n';
            out += cue.text + '\n\n';
        });
        return out;
    },

    buildVTT: function(cues) {
        var clean = Subtitles.sanitize(cues);
        var out = 'WEBVTT\n\n';
        clean.forEach(function(cue) {
            out += Subtitles.formatTimestamp(cue.start, false) + ' --> ' +
                   Subtitles.formatTimestamp(cue.end, false) + '\n';
            out += cue.text + '\n\n';
        });
        return out;
    }
};
