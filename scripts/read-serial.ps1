$port = New-Object System.IO.Ports.SerialPort('COM21', 115200, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
$port.ReadTimeout = 500
$port.DtrEnable = $false
$port.RtsEnable = $false
try {
    $port.Open()
    Write-Host 'Connected to COM21. Listening for logs...'
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline) {
        $str = $port.ReadExisting()
        if ($str -and $str.Length -gt 0) {
            Write-Host -NoNewline $str
        }
        Start-Sleep -Milliseconds 100
    }
} finally {
    if ($port.IsOpen) {
        $port.Close()
    }
}
