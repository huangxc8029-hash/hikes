Add-Type -AssemblyName System.Drawing
$destination = Join-Path $PSScriptRoot '..\src\assets'
foreach ($name in @('mountain', 'book', 'chat', 'user', 'home')) {
  $bitmap = New-Object System.Drawing.Bitmap 72, 72
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(104, 119, 143)), 4
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  switch ($name) {
    'mountain' { $graphics.DrawLines($pen, [System.Drawing.PointF[]]@((New-Object System.Drawing.PointF 7,57),(New-Object System.Drawing.PointF 28,18),(New-Object System.Drawing.PointF 40,40),(New-Object System.Drawing.PointF 47,29),(New-Object System.Drawing.PointF 66,57),(New-Object System.Drawing.PointF 7,57))) }
    'book' { $graphics.DrawLines($pen, [System.Drawing.PointF[]]@((New-Object System.Drawing.PointF 36,19),(New-Object System.Drawing.PointF 27,16),(New-Object System.Drawing.PointF 9,16),(New-Object System.Drawing.PointF 9,55),(New-Object System.Drawing.PointF 27,55),(New-Object System.Drawing.PointF 36,59),(New-Object System.Drawing.PointF 45,55),(New-Object System.Drawing.PointF 63,55),(New-Object System.Drawing.PointF 63,16),(New-Object System.Drawing.PointF 45,16),(New-Object System.Drawing.PointF 36,19))); $graphics.DrawLine($pen,36,19,36,59) }
    'chat' { $graphics.DrawEllipse($pen,12,13,48,42); $graphics.DrawLines($pen,[System.Drawing.PointF[]]@((New-Object System.Drawing.PointF 19,48),(New-Object System.Drawing.PointF 13,61),(New-Object System.Drawing.PointF 28,55))); $graphics.DrawLine($pen,26,34,46,34) }
    'user' { $graphics.DrawEllipse($pen,26,11,20,20); $graphics.DrawArc($pen,13,37,46,31,190,160) }
    'home' { $graphics.DrawLines($pen,[System.Drawing.PointF[]]@((New-Object System.Drawing.PointF 8,34),(New-Object System.Drawing.PointF 36,10),(New-Object System.Drawing.PointF 64,34))); $graphics.DrawLines($pen,[System.Drawing.PointF[]]@((New-Object System.Drawing.PointF 17,30),(New-Object System.Drawing.PointF 17,61),(New-Object System.Drawing.PointF 55,61),(New-Object System.Drawing.PointF 55,30))) }
  }
  $bitmap.Save((Join-Path $destination "nav-$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $pen.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}
