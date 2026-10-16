# Publishes the current MonoLith version to GitHub:
#  - pushes the source (from MonoLith-source.zip) to the repo and tags it v<version>
#  - creates a GitHub Release with the newest changelog entry and the program zip to download
# Run via PUBLISH-GITHUB.bat in the CAD Program folder. Needs: git + GitHub CLI (gh), logged in.
$ErrorActionPreference = 'Continue'   # native tools write to stderr; every step is checked explicitly
Set-Location $PSScriptRoot
function Fail($m) { Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }

# --- tools: installed automatically when missing ---
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') }
function Ensure-Tool($cmd, $id, $label) {
  if (Get-Command $cmd -ErrorAction SilentlyContinue) { return }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Fail "$label is missing and winget is not available. Install $label manually." }
  Write-Host "Installing $label (one time)..." -ForegroundColor Yellow
  winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements | Out-Host
  Refresh-Path
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { Fail "$label was installed but not found yet - close this window and run PUBLISH-GITHUB.bat again." }
}
Ensure-Tool git 'Git.Git' 'Git'
Ensure-Tool gh 'GitHub.cli' 'GitHub CLI'
gh auth status *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'One-time GitHub login: copy the code shown below, press Enter, paste it in the browser and click Authorize.' -ForegroundColor Yellow
  gh auth login --hostname github.com --web --git-protocol https
  if ($LASTEXITCODE -ne 0) { Fail 'GitHub login failed' }
}
gh auth setup-git *> $null

# --- repo (asked once, remembered in github-repo.txt) ---
$cfg = Join-Path $PSScriptRoot 'github-repo.txt'
if (Test-Path $cfg) { $repo = (Get-Content $cfg -Raw).Trim() } else {
  $list = @(gh repo list --limit 100 --json nameWithOwner --jq '.[].nameWithOwner')
  if ($list.Count -eq 1) { $repo = $list[0]; Write-Host "Using your repository $repo" }
  elseif ($list.Count -gt 1) {
    Write-Host 'Your repositories:'; for ($i = 0; $i -lt $list.Count; $i++) { Write-Host ("  {0}. {1}" -f ($i + 1), $list[$i]) }
    $n = Read-Host 'Number of the MonoLith repository'
    if ($n -notmatch '^\d+$' -or [int]$n -lt 1 -or [int]$n -gt $list.Count) { Fail 'Invalid choice' }
    $repo = $list[[int]$n - 1]
  } else { $repo = (Read-Host 'GitHub repository (owner/name)').Trim() }
  if ($repo -notmatch '^[\w.-]+/[\w.-]+$') { Fail "'$repo' is not in the form owner/name" }
  Set-Content $cfg $repo
}
gh repo view $repo *> $null
if ($LASTEXITCODE -ne 0) { Fail "Repository $repo not found (or no access). Fix the name in github-repo.txt." }

# --- version + release notes from the changelog ---
if (-not (Test-Path 'MonoLith-changelog.txt')) { Fail 'MonoLith-changelog.txt not found' }
$lines = Get-Content 'MonoLith-changelog.txt' -Encoding UTF8
$start = ($lines | Select-String -Pattern '^\d+\.\d+\.\d+' | Select-Object -First 1).LineNumber
if (-not $start) { Fail 'No version line found in the changelog' }
$ver = ($lines[$start - 1] -split ' ')[0]
# notes = every changelog entry since the last GitHub release (so small in-between versions are included)
$last = (gh release list --repo $repo --limit 1 --json tagName --jq '.[0].tagName' 2>$null)
if ($last) { $last = "$last".Trim().TrimStart('v') }
$notes = @()
for ($i = $start - 1; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match '^(\d+\.\d+\.\d+)') { if ($last -and $Matches[1] -eq $last) { break } }
  $notes += $lines[$i]
}
$notesText = '## Changes' + "`n`n" + (($notes -join "`n").Trim()) + "`n`n**Download:** MonoLith-$ver-win.zip below - unzip anywhere and run ``MonoLith\MonoLith.exe``."
$tag = "v$ver"
Write-Host "=== Publishing MonoLith $ver to $repo ===" -ForegroundColor Cyan

gh release view $tag --repo $repo *> $null
if ($LASTEXITCODE -eq 0) { Fail "Release $tag already exists on GitHub. Make a new version first." }

# --- program zip ---
$zip = "MonoLith $ver.zip"
if (-not (Test-Path $zip)) {
  Write-Host "Making $zip ..."
  if (-not (Test-Path 'MAKE-MONOLITH-ZIP.bat')) { Fail 'MAKE-MONOLITH-ZIP.bat not found' }
  cmd /c "echo.| MAKE-MONOLITH-ZIP.bat" | Out-Host
  if (-not (Test-Path $zip)) { Fail "$zip was not created (is MonoLith\ updated to $ver?)" }
}

# --- source: clone, replace contents with MonoLith-source.zip, commit, tag, push ---
if (-not (Test-Path 'MonoLith-source.zip')) { Fail 'MonoLith-source.zip not found' }
$work = Join-Path $env:TEMP 'monolith-publish'
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory $work | Out-Null
$repoDir = Join-Path $work 'repo'
Write-Host 'Getting the repository...'
git clone --quiet "https://github.com/$repo.git" $repoDir
if ($LASTEXITCODE -ne 0) { Fail 'git clone failed' }
Get-ChildItem $repoDir -Force | Where-Object { $_.Name -ne '.git' -and $_.Name -ne '.github' -and $_.Name -notlike 'LICENSE*' } | Remove-Item -Recurse -Force
$ErrorActionPreference = "Stop"
Expand-Archive -LiteralPath 'MonoLith-source.zip' -DestinationPath (Join-Path $work 'src') -Force
Copy-Item -Path (Join-Path $work 'src\monolith\*') -Destination $repoDir -Recurse -Force
$ErrorActionPreference = "Continue"
Set-Content (Join-Path $repoDir '.gitignore') "node_modules/`nrelease/`ndist/`nrenderer/dist/`ntests/e2e/shots/"
Copy-Item 'MonoLith-changelog.txt' (Join-Path $repoDir 'CHANGELOG.txt') -Force
Push-Location $repoDir
try {
  if (-not (git config user.name)) { git config user.name 'Wouter' }
  if (-not (git config user.email)) { git config user.email 'w.degroot@enerkorp.com' }
  git add -A
  git commit --quiet -m "MonoLith $ver" | Out-Null
  $branch = (git rev-parse --abbrev-ref HEAD).Trim(); if ($branch -eq 'HEAD') { $branch = 'main' }
  git tag $tag
  Write-Host 'Uploading source...'
  git push --quiet origin "HEAD:$branch" $tag
  if ($LASTEXITCODE -ne 0) { Fail 'git push failed' }
} finally { Pop-Location }

# --- release ---
$asset = Join-Path $work "MonoLith-$ver-win.zip"
Copy-Item -LiteralPath $zip $asset
$nf = Join-Path $work 'notes.md'; [IO.File]::WriteAllText($nf, $notesText, (New-Object Text.UTF8Encoding $false))
Write-Host "Creating release $tag and uploading $zip (this can take a few minutes)..."
gh release create $tag $asset --repo $repo --title "MonoLith $ver" --notes-file $nf
if ($LASTEXITCODE -ne 0) { Fail 'Creating the release failed' }
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ''
Write-Host "Done: https://github.com/$repo/releases/tag/$tag" -ForegroundColor Green
Write-Host "Linux: GitHub now builds 'MonoLith $ver for Linux' by itself (release $tag-linux, about 15-20 minutes)."
Write-Host "       Follow it at https://github.com/$repo/actions" 
