$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Select an existing first-frame image'
$dialog.Filter = 'Images (*.png;*.jpg;*.jpeg;*.webp)|*.png;*.jpg;*.jpeg;*.webp'
$dialog.Multiselect = $false
$dialog.CheckFileExists = $true
try {
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        @{ cancelled = $false; path = $dialog.FileName } | ConvertTo-Json -Compress
    } else {
        @{ cancelled = $true } | ConvertTo-Json -Compress
    }
} finally {
    $dialog.Dispose()
}
