$ErrorActionPreference = 'Stop'
# Resolve Node before asking for any credentials.
$nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
$nodeExecutable = $null
if ($nodeCommand) {
    $nodeExecutable = $nodeCommand.Source
} else {
    $nodeCandidates = @(
        (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'),
        (Join-Path $env:ProgramFiles 'nodejs\node.exe')
    )
    foreach ($candidate in $nodeCandidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $nodeExecutable = $candidate
            break
        }
    }
}
if (-not $nodeExecutable) {
    throw 'Node.js was not found. Install Node.js LTS 22+ from https://nodejs.org, reopen PowerShell, then retry.'
}
$nodeVersion = & $nodeExecutable --version
if ($LASTEXITCODE -ne 0 -or [int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 22) {
    throw 'Node.js 22 or newer is required. Install the current LTS release and retry.'
}
do {
    $projectUrl = Read-Host 'STEP 1 - Project URL (https://xxx.supabase.co)'
    $normalizedUrl = & $nodeExecutable (Join-Path $PSScriptRoot 'create-accounts.cjs') --check-url $projectUrl
    $urlIsValid = $LASTEXITCODE -eq 0
    if (-not $urlIsValid) { Write-Host 'Please enter the Project URL again. The secret key has not been requested yet.' }
} until ($urlIsValid)
Write-Host 'Project URL format OK.'
$secureKey = Read-Host 'Supabase service_role or secret key (hidden input)' -AsSecureString
$keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
$previousUrl = $env:SUPABASE_URL
$previousKey = $env:SUPABASE_SERVICE_ROLE_KEY
try {
    $env:SUPABASE_URL = $normalizedUrl
    $env:SUPABASE_SERVICE_ROLE_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
    & $nodeExecutable (Join-Path $PSScriptRoot 'create-accounts.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Account setup failed. Read the error above.' }
    Write-Host 'Open .local/accounts.txt for your three passwords. Do not upload this file.'
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
    $env:SUPABASE_SERVICE_ROLE_KEY = $previousKey
    $env:SUPABASE_URL = $previousUrl
}
