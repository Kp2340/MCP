$projectRoot = "C:\Users\kushp\Downloads\mcp-v9_1\mcp"
$outputFile = "$projectRoot\combined_code.txt"

# Remove previous export
if (Test-Path $outputFile) {
    Remove-Item $outputFile -Force
}

# UTF-8 writer
$writer = New-Object System.IO.StreamWriter($outputFile, $false, [System.Text.Encoding]::UTF8)

# Allowed extensions
$extensions = @(
    ".js",
    ".ts",
    ".jsx",
    ".tsx",
    ".json",
    ".md",
    ".yaml",
    ".yml",
    ".ps1"
)

# Folders to ignore
$ignoreFolders = @(
    "node_modules",
    ".git",
    ".next",
    "out",
    "dist",
    "build",
    "target",
    ".gradle",
    ".cache",
    "coverage"
)

Write-Host "Exporting project files..."

Get-ChildItem $projectRoot -Recurse -File |
Where-Object {

    $path = $_.FullName

    # Skip ignored folders
    foreach ($folder in $ignoreFolders) {
        if ($path -like "*\$folder\*") { return $false }
    }

    # Skip export file
    if ($_.Name -eq "combined_code.txt") { return $false }

    # Skip lock files
    if ($_.Name -eq "package-lock.json") { return $false }

    # Skip secrets
    if ($_.Name -eq ".env") { return $false }

    # Only allowed extensions
    if ($extensions -notcontains $_.Extension) { return $false }

    return $true

} |
ForEach-Object {

    $writer.WriteLine("========================================")
    $writer.WriteLine("FILE: $($_.FullName)")
    $writer.WriteLine("========================================")

    try {

        # Prevent exporting very large files
        if ($_.Length -gt 2MB) {
            $writer.WriteLine("[FILE TOO LARGE - SKIPPED]")
        }
        else {
            $content = Get-Content $_.FullName -Raw -ErrorAction Stop
            $writer.WriteLine($content)
        }

    }
    catch {
        $writer.WriteLine("[ERROR READING FILE]")
    }

    $writer.WriteLine("")
}

$writer.Close()

Write-Host "Export complete -> $outputFile"