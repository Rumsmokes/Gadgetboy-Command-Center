param(
  [string]$Version,
  [string]$Tag,
  [string]$Repo,
  [string]$Notes
)

$ErrorActionPreference = 'Stop'

function Read-GitHubTokenToEnv {
  if ($env:GITHUB_TOKEN) {
    return
  }

  Write-Host 'GITHUB_TOKEN is not set. Paste a GitHub Personal Access Token (input hidden) to publish the release.'
  $secure = Read-Host -AsSecureString -Prompt 'GitHub token'
  if (-not $secure) {
    throw 'No token provided.'
  }

  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $env:GITHUB_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
  } finally {
    if ($bstr -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
  }
}

function Get-RepoSlugFromOrigin {
  $origin = (git remote get-url origin) 2>$null
  if (-not $origin) { return $null }

  if ($origin -match 'github\.com[:/](?<slug>[^/]+/[^/.]+)(\.git)?$') {
    return $Matches.slug
  }

  return $null
}

function Get-PackageJsonVersion {
  $pkgPath = Join-Path $PSScriptRoot '..\package.json'
  if (-not (Test-Path $pkgPath)) { return $null }
  try {
    $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
    return [string]$pkg.version
  } catch {
    return $null
  }
}

function Get-ReleaseByTag([hashtable]$Headers, [string]$RepoSlug, [string]$TagName) {
  try {
    return Invoke-RestMethod -Headers $Headers -Uri "https://api.github.com/repos/$RepoSlug/releases/tags/$TagName"
  } catch {
    return $null
  }
}

function New-Release([hashtable]$Headers, [string]$RepoSlug, [string]$TagName, [string]$Body) {
  $payload = @{
    tag_name    = $TagName
    name        = $TagName
    body        = $Body
    draft       = $false
    prerelease  = $false
  }

  # Windows PowerShell can send string bodies as UTF-16; GitHub expects UTF-8 JSON.
  $json = ($payload | ConvertTo-Json -Compress)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  return Invoke-RestMethod -Method Post -Headers $Headers -Uri "https://api.github.com/repos/$RepoSlug/releases" -Body $bytes -ContentType 'application/json; charset=utf-8'
}

function Send-ReleaseAsset([hashtable]$Headers, [string]$UploadUrlBase, [string]$FilePath) {
  $name = [System.IO.Path]::GetFileName($FilePath)
  $nameEsc = [uri]::EscapeDataString($name)
  $u = "${UploadUrlBase}?name=$nameEsc"

  Write-Host "Uploading: $name"
  # -UseBasicParsing prevents Windows PowerShell 5.1 from prompting about the IE engine.
  Invoke-WebRequest -Method Post -Headers $Headers -ContentType 'application/octet-stream' -InFile $FilePath -Uri $u -UseBasicParsing | Out-Null
}

function Remove-ReleaseAsset([hashtable]$Headers, $Asset) {
  try {
    if ($Asset -and $Asset.url) {
      Write-Host "Deleting existing asset: $($Asset.name)"
      Invoke-RestMethod -Method Delete -Headers $Headers -Uri $Asset.url | Out-Null
    }
  } catch {
    throw "Failed deleting release asset '$($Asset.name)': $($_.Exception.Message)"
  }
}

Read-GitHubTokenToEnv

if (-not $env:GITHUB_TOKEN) {
  throw 'GITHUB_TOKEN is still not set after prompting.'
}

if (-not $Repo) {
  $Repo = Get-RepoSlugFromOrigin
}

if (-not $Repo) {
  throw 'Could not determine GitHub repo slug. Pass -Repo owner/repo (example: Rumsmokes/Gadgetboy-Command-Center).'
}

if (-not $Version) {
  $Version = Get-PackageJsonVersion
}

if (-not $Version) {
  throw 'Could not determine version. Pass -Version 0.2.55 or ensure package.json has a version field.'
}

if (-not $Tag) {
  $Tag = "v$Version"
}

if (-not $Notes) {
  $Notes = @(
    "Release $Version",
    '',
    'Changes:',
    '- Mobile PDF export: explicit Open/Download/Share actions after Finalize.',
    '- Clear reliably resets name + date (native form reset).',
    '- Clearer guidance when email attachment viewers block scripts (download HTML then open from Files/Downloads).'
  ) -join "`n"
}

$headers = @{
  Authorization = "Bearer $env:GITHUB_TOKEN"
  'User-Agent'  = 'gbpos-release'
  Accept        = 'application/vnd.github+json'
}

$release = Get-ReleaseByTag -Headers $headers -RepoSlug $Repo -TagName $Tag
if (-not $release) {
  Write-Host "Creating GitHub Release: $Repo $Tag"
  $release = New-Release -Headers $headers -RepoSlug $Repo -TagName $Tag -Body $Notes
} else {
  Write-Host "GitHub Release already exists: $($release.html_url)"
}

$uploadUrlBase = ([string]$release.upload_url).Trim()
# GitHub returns an RFC6570 URL template like: .../assets{?name,label}
# Strip any template portion to get a valid base URL.
$uploadUrlBase = ($uploadUrlBase -replace '\{.*$', '')
if (-not $uploadUrlBase) {
  throw 'Missing upload_url from GitHub release response.'
}

$releaseDir = Join-Path $PSScriptRoot '..\release'
$setupPath = Join-Path $releaseDir "GadgetBoy-POS-Setup-$Version.exe"
$setupBlockmapPath = Join-Path $releaseDir "GadgetBoy-POS-Setup-$Version.exe.blockmap"
$updatePath = Join-Path $releaseDir "GadgetBoy-POS-Update-$Version.exe"

if (-not (Test-Path $updatePath) -and (Test-Path $setupPath)) {
  Copy-Item -Force $setupPath $updatePath
}

$assetPaths = @(
  $setupPath,
  $setupBlockmapPath,
  $updatePath,
  (Join-Path $releaseDir 'latest.yml')
)

foreach ($p in $assetPaths) {
  if (-not (Test-Path $p)) {
    throw "Missing asset file: $p"
  }
}

# Refresh release to get current assets list before uploading
$release = Get-ReleaseByTag -Headers $headers -RepoSlug $Repo -TagName $Tag

$expectedAssetNames = @{}
foreach ($p in $assetPaths) {
  $expectedAssetNames[[System.IO.Path]::GetFileName($p)] = $true
}

foreach ($asset in @($release.assets)) {
  if (-not $asset) { continue }
  $isSourceArchive = ($asset.name -like 'Source code*')
  if ($isSourceArchive) { continue }
  if (-not $expectedAssetNames.ContainsKey([string]$asset.name)) {
    Remove-ReleaseAsset -Headers $headers -Asset $asset
  }
}

$release = Get-ReleaseByTag -Headers $headers -RepoSlug $Repo -TagName $Tag

foreach ($p in $assetPaths) {
  $name = [System.IO.Path]::GetFileName($p)
  $existing = $null
  try {
    $existing = @($release.assets | Where-Object { $_.name -eq $name })[0]
  } catch {
    $existing = $null
  }

  if ($existing -and $existing.url) {
    Remove-ReleaseAsset -Headers $headers -Asset $existing
  }

  Send-ReleaseAsset -Headers $headers -UploadUrlBase $uploadUrlBase -FilePath $p
}

$release = Get-ReleaseByTag -Headers $headers -RepoSlug $Repo -TagName $Tag
Write-Host "Published: $($release.html_url)"
