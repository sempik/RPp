# Text from a video frame with Windows' built-in OCR (the engine the Snipping Tool uses).
# RPp passes this script on stdin and the PNG path in RPP_OCR_IMAGE; it prints one JSON line.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await($op, [type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(); $task.Result }

$langs = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
if (-not $langs.Count) { '{"error":"nolang"}'; exit }
# Russian also reads Latin letters (nicknames), so prefer it when it is installed
$tag = @(@($langs | Where-Object { $_ -like 'ru*' }) + $langs)[0]
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($tag))

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:RPP_OCR_IMAGE)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$stream.Dispose()

$lines = @(foreach ($line in $result.Lines) {
  $x0 = 1e9; $y0 = 1e9; $x1 = 0; $y1 = 0
  foreach ($word in $line.Words) {
    $r = $word.BoundingRect
    $x0 = [Math]::Min($x0, $r.X); $y0 = [Math]::Min($y0, $r.Y)
    $x1 = [Math]::Max($x1, $r.X + $r.Width); $y1 = [Math]::Max($y1, $r.Y + $r.Height)
  }
  @{ text = $line.Text; x = $x0; y = $y0; w = $x1 - $x0; h = $y1 - $y0 }
})
ConvertTo-Json -Compress -Depth 4 @{ lang = $tag; lines = $lines }
