# Draws the app icon (dark tile, blue play triangle, red REC dot) and writes a multi-size PNG-based .ico.
param([string]$Out = (Join-Path $PSScriptRoot '..\app\icon.ico'))
Add-Type -AssemblyName System.Drawing

function New-IconPng([int]$s) {
    $bmp = New-Object Drawing.Bitmap $s, $s
    $g = [Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([Drawing.Color]::Transparent)

    $r = [single]($s * 0.22); $pad = [single]($s * 0.04); $w = [single]($s - 2 * $pad)
    $tile = New-Object Drawing.Drawing2D.GraphicsPath
    $tile.AddArc($pad, $pad, 2 * $r, 2 * $r, 180, 90)
    $tile.AddArc($pad + $w - 2 * $r, $pad, 2 * $r, 2 * $r, 270, 90)
    $tile.AddArc($pad + $w - 2 * $r, $pad + $w - 2 * $r, 2 * $r, 2 * $r, 0, 90)
    $tile.AddArc($pad, $pad + $w - 2 * $r, 2 * $r, 2 * $r, 90, 90)
    $tile.CloseFigure()
    $grad = New-Object Drawing.Drawing2D.LinearGradientBrush ([Drawing.PointF]::new(0, 0)), ([Drawing.PointF]::new(0, $s)),
        ([Drawing.Color]::FromArgb(255, 46, 43, 39)), ([Drawing.Color]::FromArgb(255, 21, 20, 18))
    $g.FillPath($grad, $tile)
    if ($s -ge 32) {
        $pen = New-Object Drawing.Pen ([Drawing.Color]::FromArgb(70, 255, 255, 255)), ([single][Math]::Max(1, $s / 64))
        $g.DrawPath($pen, $tile)
    }

    # play triangle, optically centred
    $cx = $s * 0.52; $cy = $s * 0.53; $h = $s * 0.40
    $tri = [Drawing.PointF[]]@(
        [Drawing.PointF]::new($cx - $h * 0.42, $cy - $h / 2),
        [Drawing.PointF]::new($cx + $h * 0.50, $cy),
        [Drawing.PointF]::new($cx - $h * 0.42, $cy + $h / 2))
    $g.FillPolygon((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(255, 94, 242, 208))), $tri)

    # REC dot
    $d = $s * 0.20; $dx = $s * 0.70; $dy = $s * 0.12
    $g.FillEllipse((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(255, 255, 75, 62))), [single]$dx, [single]$dy, [single]$d, [single]$d)

    $g.Dispose()
    $ms = New-Object IO.MemoryStream
    $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return , $ms.ToArray()
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = foreach ($s in $sizes) { , (New-IconPng $s) }

$fs = [IO.File]::Create((Resolve-Path -LiteralPath (Split-Path $Out)).Path + '\' + (Split-Path $Out -Leaf))
$bw = New-Object IO.BinaryWriter $fs
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]; $b = if ($s -ge 256) { 0 } else { $s }
    $bw.Write([byte]$b); $bw.Write([byte]$b); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$pngs[$i].Length); $bw.Write([uint32]$offset)
    $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $bw.Write($p) }
$bw.Close()
[IO.File]::WriteAllBytes((Join-Path (Split-Path $Out) 'icon.png'), (New-IconPng 256))
Write-Host "Icon written: $Out"
