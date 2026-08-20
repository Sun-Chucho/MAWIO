param(
  [Parameter(Mandatory = $true)]
  [string]$WorkbookPath,
  [string]$DatabaseBaseUrl = "https://mawio-67c3b-default-rtdb.firebaseio.com/mawio/standard/current"
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $WorkbookPath)) {
  throw "Workbook not found: $WorkbookPath"
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $WorkbookPath))

try {
  function Read-WorkbookXml([string]$entryName) {
    $entry = $archive.GetEntry($entryName)
    if ($null -eq $entry) { throw "Missing workbook entry: $entryName" }
    $reader = New-Object System.IO.StreamReader($entry.Open())
    try { return [xml]$reader.ReadToEnd() } finally { $reader.Dispose() }
  }

  $sharedStringsXml = Read-WorkbookXml "xl/sharedStrings.xml"
  $sharedStrings = @($sharedStringsXml.sst.si | ForEach-Object { $_.InnerText })
  $sheetXml = Read-WorkbookXml "xl/worksheets/sheet1.xml"
  $sourceItems = @()

  foreach ($row in $sheetXml.worksheet.sheetData.row | Where-Object { [int]$_.r -ge 4 -and [int]$_.r -le 60 }) {
    $cells = @{}
    foreach ($cell in $row.c) {
      $column = ([string]$cell.r -replace "\d", "")
      $value = if ($cell.t -eq "s") {
        $sharedStrings[[int]$cell.v]
      } elseif ($cell.t -eq "inlineStr") {
        $cell.is.InnerText
      } else {
        [string]$cell.v
      }
      $cells[$column] = $value
    }

    $name = (([string]$cells["B"]).Trim() -replace "\s+", " ")
    if (-not $name) { continue }

    $sourceItems += [pscustomobject]@{
      Row = [int]$row.r
      Name = $name
      Unit = if (([string]$cells["C"]).Trim()) { ([string]$cells["C"]).Trim() } else { "Bottle" }
      FinalQuantity = [double]$cells["E"]
      SellingPrice = [double]$cells["F"]
      BuyingPrice = [double]$cells["G"]
    }
  }
} finally {
  $archive.Dispose()
}

if ($sourceItems.Count -ne 57) { throw "Expected 57 stock items, found $($sourceItems.Count)." }
if (@($sourceItems | Group-Object Name | Where-Object Count -gt 1).Count -gt 0) { throw "Duplicate item names found." }
if (@($sourceItems | Where-Object { $_.SellingPrice -le 0 -or $_.BuyingPrice -le 0 }).Count -gt 0) { throw "Missing or invalid prices found." }

function Get-SubCategory([string]$name) {
  if ($name -match "WINE|COUSINS|DROST|ROBERTSON|DODOMA|ALTRA|SAINT ANNA|IMAGI|DOMPOO") { return "Wine" }
  if ($name -match "KILIMANJARO L/S|SAFARI|CASTLE|SERENGETI|BRUTAL|SMIRNOFF ICE|SAVANA|DESPERADO|FLAYING|HEINEKEN|WINDHOEK|REDDS|GRAND MALT") { return "Beer and Cider" }
  if ($name -match "WATER") { return "Water" }
  if ($name -match "ENERGY|RED BULL") { return "Energy Drinks" }
  if ($name -match "JUICE|CERES") { return "Juice" }
  if ($name -match "COCA|PEPSI") { return "Soft Drinks" }
  return "Spirits"
}

$storeUri = "$DatabaseBaseUrl/orange-hotel-main-store-items.json"
$inventoryUri = "$DatabaseBaseUrl/orange-hotel-inventory-items.json"
$baristaStateUri = "$DatabaseBaseUrl/orange-hotel-barista-state.json"
$existingStore = @((Invoke-RestMethod -Method Get -Uri $storeUri) | Where-Object { $_ -isnot [string] -and $null -ne $_.PSObject.Properties["lane"] })
$existingInventory = @((Invoke-RestMethod -Method Get -Uri $inventoryUri) | Where-Object { $_ -isnot [string] -and $null -ne $_.PSObject.Properties["category"] })
$existingBaristaState = Invoke-RestMethod -Method Get -Uri $baristaStateUri

$barStore = @($sourceItems | ForEach-Object {
  [ordered]@{
    id = "bar-final-2026-08-$($_.Row)"
    name = $_.Name
    stock = $_.FinalQuantity
    unit = $_.Unit
    minStock = 1
    lane = "barista"
    subCategory = Get-SubCategory $_.Name
    buyingPrice = $_.BuyingPrice
    sellingPrice = $_.SellingPrice
    totSold = 0
    damages = 0
    receivedStock = 0
  }
})

$barInventory = @($sourceItems | ForEach-Object {
  [ordered]@{
    id = "inv-bar-final-2026-08-$($_.Row)"
    barcode = ""
    name = $_.Name
    category = "Bar"
    subCategory = Get-SubCategory $_.Name
    size = ""
    stock = $_.FinalQuantity
    totSold = 0
    buyingPrice = $_.BuyingPrice
    sellingPrice = $_.SellingPrice
    price = $_.SellingPrice
    status = "ACTIVE"
    minStock = 1
    unit = $_.Unit
    damages = 0
    receivedStock = 0
  }
})

$barMenu = @($sourceItems | ForEach-Object {
  [ordered]@{
    id = "bar-menu-final-2026-08-$($_.Row)"
    name = $_.Name
    price = $_.SellingPrice
    buyingPrice = $_.BuyingPrice
    category = "cold"
    prepMinutes = 1
  }
})

$nextStore = @($existingStore | Where-Object { $_.lane -ne "barista" }) + $barStore
$nextInventory = @($existingInventory | Where-Object { $_.category -ne "Bar" }) + $barInventory
$nextBaristaState = [ordered]@{
  tickets = if ($null -ne $existingBaristaState -and $existingBaristaState.tickets) { @($existingBaristaState.tickets) } else { @() }
  ticketSeq = if ($null -ne $existingBaristaState -and $existingBaristaState.ticketSeq) { [int]$existingBaristaState.ticketSeq } else { 1 }
  payments = if ($null -ne $existingBaristaState -and $existingBaristaState.payments) { @($existingBaristaState.payments) } else { @() }
  menuItems = $barMenu
}

Invoke-RestMethod -Method Put -Uri $storeUri -ContentType "application/json" -Body ($nextStore | ConvertTo-Json -Depth 20 -Compress) | Out-Null
Invoke-RestMethod -Method Put -Uri $inventoryUri -ContentType "application/json" -Body ($nextInventory | ConvertTo-Json -Depth 20 -Compress) | Out-Null
Invoke-RestMethod -Method Put -Uri $baristaStateUri -ContentType "application/json" -Body ($nextBaristaState | ConvertTo-Json -Depth 20 -Compress) | Out-Null

Write-Output "Imported $($sourceItems.Count) authoritative Bar stock items."
Write-Output "Total final quantity: $(($sourceItems | Measure-Object FinalQuantity -Sum).Sum)"
