// Voice-over for the App Store screencast, using only macOS built-ins (AVFoundation + `say`).
//   swift scripts/voiceover.swift frames <video> <outDir> [everySeconds]   → JPEG frames named t0000.jpg … (seconds)
//   swift scripts/voiceover.swift merge  <video> <lines.json> <out.mp4>   → video + narration (+ <out>.srt captions)
// lines.json: { "keep": [[0, 8], [12, 30], …], "lines": [{ "at": 3.5, "text": "…" }, …] }
//   keep = source-video ranges (seconds) joined in order (omit to keep everything); "at" is on the edited timeline.
//   Each line is spoken by `say` (voice: $VOICE, default Daniel).
import AVFoundation
import AppKit

let args = CommandLine.arguments
func fail(_ m: String) -> Never { FileHandle.standardError.write((m + "\n").data(using: .utf8)!); exit(1) }
guard args.count >= 4 else { fail("usage: frames <video> <outDir> [every] | merge <video> <lines.json> <out.mp4>") }

let asset = AVURLAsset(url: URL(fileURLWithPath: args[2]))
let duration = CMTimeGetSeconds(asset.duration)

if args[1] == "frames" {
  let out = URL(fileURLWithPath: args[3]), every = Double(args.count > 4 ? args[4] : "1") ?? 1
  try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
  let gen = AVAssetImageGenerator(asset: asset)
  gen.appliesPreferredTrackTransform = true
  gen.maximumSize = CGSize(width: 960, height: 960)
  gen.requestedTimeToleranceBefore = .zero; gen.requestedTimeToleranceAfter = .zero
  var t = 0.0
  while t < duration {
    if let cg = try? gen.copyCGImage(at: CMTime(seconds: t, preferredTimescale: 600), actualTime: nil),
       let jpg = NSBitmapImageRep(cgImage: cg).representation(using: .jpeg, properties: [.compressionFactor: 0.6]) {
      try jpg.write(to: out.appendingPathComponent(String(format: "t%04d.jpg", Int(t))))
    }
    t += every
  }
  print("frames written, duration \(duration)s")
  exit(0)
}

guard args[1] == "merge", args.count >= 5 else { fail("unknown command") }
struct Line: Decodable { let at: Double; let text: String; let file: String? }  // file = pre-made audio (e.g. a neural voice)
struct Plan: Decodable { let keep: [[Double]]?; let lines: [Line] }
let plan = try JSONDecoder().decode(Plan.self, from: Data(contentsOf: URL(fileURLWithPath: args[3])))
let lines = plan.lines
let outURL = URL(fileURLWithPath: args[4]), tmp = FileManager.default.temporaryDirectory
let voice = ProcessInfo.processInfo.environment["VOICE"] ?? "Daniel"

let comp = AVMutableComposition()
let vTrack = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!
let src = asset.tracks(withMediaType: .video)[0]
let keep = plan.keep ?? [[0, duration]]
var cursor = CMTime.zero
for k in keep {
  let r = CMTimeRange(start: CMTime(seconds: k[0], preferredTimescale: 600), end: CMTime(seconds: min(k[1], duration), preferredTimescale: 600))
  try vTrack.insertTimeRange(r, of: src, at: cursor)
  cursor = cursor + r.duration
}
vTrack.preferredTransform = src.preferredTransform
let outDuration = CMTimeGetSeconds(cursor)
let aTrack = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!

var srt = "", next = 0.0
for (i, l) in lines.enumerated() {
  var f = tmp.appendingPathComponent("vo\(i).aiff")
  if let file = l.file { f = URL(fileURLWithPath: file) } else {
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/say"); p.arguments = ["-v", voice, "-o", f.path, l.text]
    try p.run(); p.waitUntilExit()
  }
  let a = AVURLAsset(url: f), len = CMTimeGetSeconds(a.duration)
  let start = max(l.at, next)                               // never overlap the previous line
  if start + len > outDuration { print("warning: line \(i + 1) runs past the end of the video") }
  try aTrack.insertTimeRange(CMTimeRange(start: .zero, duration: a.duration), of: a.tracks(withMediaType: .audio)[0], at: CMTime(seconds: start, preferredTimescale: 600))
  if start > l.at + 0.05 { print("note: line \(i + 1) starts at \(String(format: "%.1f", start))s (asked \(l.at)s) — previous line still speaking") }
  let ts = { (s: Double) in String(format: "%02d:%02d:%02d,%03d", Int(s) / 3600, Int(s) / 60 % 60, Int(s) % 60, Int((s - floor(s)) * 1000)) }
  srt += "\(i + 1)\n\(ts(start)) --> \(ts(start + len))\n\(l.text)\n\n"
  next = start + len + 0.3
}

try? FileManager.default.removeItem(at: outURL)
guard let ex = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetHighestQuality) else { fail("cannot export") }
ex.outputURL = outURL; ex.outputFileType = .mp4
let sem = DispatchSemaphore(value: 0)
ex.exportAsynchronously { sem.signal() }
sem.wait()
guard ex.status == .completed else { fail("export failed: \(String(describing: ex.error))") }
try srt.write(to: outURL.deletingPathExtension().appendingPathExtension("srt"), atomically: true, encoding: .utf8)
print("wrote \(outURL.path) and captions .srt")
