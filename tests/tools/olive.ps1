# Reports how much of a capture looks olive: dim colours whose hue lies between orange and green.
# usage: olive.ps1 <png> [skipRightPixels]
param([string]$Path, [int]$SkipRight = 340)
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap $Path
$total = 0; $olive = 0; $sum = 0.0; $worst = 0
for ($y = 8; $y -lt $bmp.Height - 8; $y += 8) {
  for ($x = 8; $x -lt $bmp.Width - $SkipRight; $x += 8) {
    $c = $bmp.GetPixel($x, $y)
    $total++
    $h = $c.GetHue(); $b = $c.GetBrightness()
    if ($c.GetSaturation() -lt 0.04) { continue }
    $sum += $h
    if ($h -gt 34 -and $h -lt 100 -and $b -lt 0.62) {
      $olive++
      if ($h -gt $worst) { $worst = $h }
    }
  }
}
$bmp.Dispose()
"{0}: olive {1:N1}% of sampled pixels, highest olive hue {2:N0}" -f (Split-Path $Path -Leaf), (100.0 * $olive / $total), $worst
