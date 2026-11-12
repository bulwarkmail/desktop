; The NSIS installer's managed deployment switches, the same as the MSI's properties:
;
;   Bulwark-Setup.exe /S /INSTANCE_URL=https://mail.example.com /FORCE_INSTANCE=1 /UPDATE_CHANNEL=stable
;
; writes HKLM\SOFTWARE\Policies\Bulwark\Desktop, or \Recommended without
; /FORCE_INSTANCE=1, and takes the value out of the other one. electron-builder includes
; this file by itself. /FORCE_INSTANCE=1 needs /INSTANCE_URL=: without it nothing is
; written and the installer ends with exit code 87, since an install that looks forced
; and isn't would be worse.
;
; The per-user install doesn't elevate, and only an administrator can write policies. So
; this has to run elevated. If it can't write, it says so and ends with exit code 5: the
; app is installed, but silently leaving it unmanaged would be worse.
;
; Nothing here removes the values on uninstall: updates run the old uninstaller, and a
; machine's policy isn't this installer's to take back.

!include "FileFunc.nsh"
!include "LogicLib.nsh"

; The window: build/installer-theme.nsh.
!include "${__FILEDIR__}\installer-theme.nsh"

!ifndef BUILD_UNINSTALLER
; Not ${GetOptions}: it ends a value at the next "/", which is most of an address.
; A value runs to the next space, or is in double quotes. Sets the error flag if absent.
; Push the parameters, push the option; pops both and leaves the value on the stack.
Function bulwarkOption
  Exch $R1
  Exch
  Exch $R0
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  StrLen $R2 $R1
  StrCpy $R3 0
  ClearErrors
find:
  StrCpy $R4 $R0 $R2 $R3
  StrCmp $R4 "" absent
  StrCmp $R4 $R1 0 next
  ; An option starts the line or follows a space or a quote.
  IntCmp $R3 0 found
  IntOp $R4 $R3 - 1
  StrCpy $R4 $R0 1 $R4
  StrCmp $R4 " " found
  StrCmp $R4 '"' found
next:
  IntOp $R3 $R3 + 1
  Goto find
found:
  IntOp $R3 $R3 + $R2
  StrCpy $R0 $R0 "" $R3
  StrCpy $R5 " "
  StrCpy $R4 $R0 1
  StrCmp $R4 '"' 0 scan
  StrCpy $R5 '"'
  StrCpy $R0 $R0 "" 1
scan:
  StrCpy $R3 0
scanNext:
  StrCpy $R4 $R0 1 $R3
  StrCmp $R4 "" done
  StrCmp $R4 $R5 done
  IntOp $R3 $R3 + 1
  Goto scanNext
done:
  StrCpy $R0 $R0 $R3
  ; No quotes in a value: the app's check would refuse it, but it shouldn't get that far.
  StrCpy $R5 ""
  StrCpy $R3 0
strip:
  StrCpy $R4 $R0 1 $R3
  StrCmp $R4 "" stripped
  IntOp $R3 $R3 + 1
  StrCmp $R4 '"' strip
  StrCpy $R5 "$R5$R4"
  Goto strip
stripped:
  StrCpy $R0 $R5
  ClearErrors
  Goto finish
absent:
  StrCpy $R0 ""
  SetErrors
finish:
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Exch
  Pop $R1
  Exch $R0
FunctionEnd
!endif

!ifndef BULWARK_POLICY_HIVE
  !define BULWARK_POLICY_HIVE "HKLM"
!endif
!ifndef BULWARK_POLICY_KEY
  !define BULWARK_POLICY_KEY "SOFTWARE\Policies\Bulwark\Desktop"
!endif

!macro bulwarkWritePolicies
  Push $0
  Push $1
  Push $2
  Push $3
  ${GetParameters} $0

  Push $0
  Push "/FORCE_INSTANCE="
  Call bulwarkOption
  Pop $1
  Push $4
  ${If} $1 == "1"
    StrCpy $2 "${BULWARK_POLICY_KEY}"
    StrCpy $4 "${BULWARK_POLICY_KEY}\Recommended"
  ${Else}
    StrCpy $2 "${BULWARK_POLICY_KEY}\Recommended"
    StrCpy $4 "${BULWARK_POLICY_KEY}"
  ${EndIf}

  StrCpy $3 ""
  ${If} $1 == "1"
    Push $0
    Push "/INSTANCE_URL="
    Call bulwarkOption
    Pop $3
    ${If} ${Errors}
    ${OrIf} $3 == ""
      StrCpy $3 "stop"
    ${Else}
      StrCpy $3 ""
    ${EndIf}
  ${EndIf}

  SetRegView 64
  StrCpy $1 ""

  ${If} $3 == "stop"
    StrCpy $1 "unforced"
    Goto bulwarkPoliciesDone
  ${EndIf}

  Push $0
  Push "/INSTANCE_URL="
  Call bulwarkOption
  Pop $3
  ${IfNot} ${Errors}
    ClearErrors
    WriteRegStr ${BULWARK_POLICY_HIVE} "$2" "InstanceUrl" "$3"
    ${If} ${Errors}
      StrCpy $1 "failed"
    ${Else}
      DeleteRegValue ${BULWARK_POLICY_HIVE} "$4" "InstanceUrl"
    ${EndIf}
  ${EndIf}

  Push $0
  Push "/UPDATE_CHANNEL="
  Call bulwarkOption
  Pop $3
  ${IfNot} ${Errors}
    ClearErrors
    WriteRegStr ${BULWARK_POLICY_HIVE} "$2" "UpdateChannel" "$3"
    ${If} ${Errors}
      StrCpy $1 "failed"
    ${Else}
      DeleteRegValue ${BULWARK_POLICY_HIVE} "$4" "UpdateChannel"
    ${EndIf}
  ${EndIf}

bulwarkPoliciesDone:
  SetRegView lastused
  Pop $4
  ${If} $1 == "unforced"
    SetErrorLevel 87
    MessageBox MB_ICONEXCLAMATION|MB_OK "Bulwark was installed, but /FORCE_INSTANCE=1 needs /INSTANCE_URL=. No settings were written." /SD IDOK
  ${EndIf}
  ${If} $1 == "failed"
    SetErrorLevel 5
    MessageBox MB_ICONEXCLAMATION|MB_OK "Bulwark was installed, but its settings could not be written. Run the installer as an administrator to set /INSTANCE_URL or /UPDATE_CHANNEL." /SD IDOK
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

; "Open with" for documents and pictures, Bulwark under "Choose another app", and
; "Bulwark (as attachment)" in Send to: the same keys the app writes at its start
; (src/main/features/os-rules.ts), so they are there before the first start. Never the
; default for a type. A forced OpenWithEnabled policy other than 1 leaves them out, as the
; app does. An update keeps a Send to entry the user deleted deleted.
!ifndef BULWARK_CLASSES_KEY
  !define BULWARK_CLASSES_KEY "Software\Classes"
!endif
!ifndef BULWARK_SENDTO_DIR
  !define BULWARK_SENDTO_DIR "$APPDATA\Microsoft\Windows\SendTo"
!endif

!macro bulwarkOpenWithCheck HIVE
  ClearErrors
  ReadRegDWORD $R0 ${HIVE} "${BULWARK_POLICY_KEY}" "OpenWithEnabled"
  ${IfNot} ${Errors}
    ${If} $R0 != 1
      StrCpy $R1 "off"
    ${EndIf}
  ${Else}
    ClearErrors
    ReadRegStr $R0 ${HIVE} "${BULWARK_POLICY_KEY}" "OpenWithEnabled"
    ${IfNot} ${Errors}
    ${AndIf} $R0 != "1"
      StrCpy $R1 "off"
    ${EndIf}
  ${EndIf}
!macroend

!macro bulwarkRegisterOpenWith
  Push $R0
  Push $R1
  StrCpy $R1 "on"
  SetRegView 64
  !insertmacro bulwarkOpenWithCheck HKLM
  SetRegView lastused
  !insertmacro bulwarkOpenWithCheck HKCU
  ${If} $R1 == "on"
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\Bulwark.File.attach" "" "File to send with Bulwark"
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\Bulwark.File.attach" "FriendlyTypeName" "File to send with Bulwark"
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\Bulwark.File.attach\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\Bulwark.File.attach\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" -- "%1"'
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\.pdf\OpenWithProgids" "Bulwark.File.attach" ""
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\.doc\OpenWithProgids" "Bulwark.File.attach" ""
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\.docx\OpenWithProgids" "Bulwark.File.attach" ""
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\.xls\OpenWithProgids" "Bulwark.File.attach" ""
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\.xlsx\OpenWithProgids" "Bulwark.File.attach" ""
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\.ppt\OpenWithProgids" "Bulwark.File.attach" ""
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\.pptx\OpenWithProgids" "Bulwark.File.attach" ""
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\.odt\OpenWithProgids" "Bulwark.File.attach" ""
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\.ods\OpenWithProgids" "Bulwark.File.attach" ""
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\.odp\OpenWithProgids" "Bulwark.File.attach" ""
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\.rtf\OpenWithProgids" "Bulwark.File.attach" ""
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\.txt\OpenWithProgids" "Bulwark.File.attach" ""
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\.csv\OpenWithProgids" "Bulwark.File.attach" ""
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\.jpg\OpenWithProgids" "Bulwark.File.attach" ""
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\.jpeg\OpenWithProgids" "Bulwark.File.attach" ""
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\.png\OpenWithProgids" "Bulwark.File.attach" ""
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\.gif\OpenWithProgids" "Bulwark.File.attach" ""
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\.webp\OpenWithProgids" "Bulwark.File.attach" ""
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\.heic\OpenWithProgids" "Bulwark.File.attach" ""
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\.bmp\OpenWithProgids" "Bulwark.File.attach" ""
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\.tif\OpenWithProgids" "Bulwark.File.attach" ""
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\.tiff\OpenWithProgids" "Bulwark.File.attach" ""
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\.svg\OpenWithProgids" "Bulwark.File.attach" ""
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\.zip\OpenWithProgids" "Bulwark.File.attach" ""
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "Bulwark"
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\Applications\${APP_EXECUTABLE_FILENAME}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
    WriteRegStr HKCU "${BULWARK_CLASSES_KEY}\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" -- "%1"'
    ${IfNot} ${isUpdated}
      CreateShortCut "${BULWARK_SENDTO_DIR}\Bulwark (as attachment).lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--bulwark-send-to --" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
    ${EndIf}
  ${EndIf}
  Pop $R1
  Pop $R0
!macroend

!macro customInstall
  !ifmacrodef bulwarkThemeRegisterStep
    !insertmacro bulwarkThemeRegisterStep
  !endif
  !insertmacro bulwarkWritePolicies
  !insertmacro bulwarkRegisterOpenWith
  !ifmacrodef bulwarkThemeDoneStep
    !insertmacro bulwarkThemeDoneStep
  !endif
!macroend

; What the app writes at runtime outside its folder goes at a real uninstall (see also
; src/main/features/os-default-app.ts, os-toasts.ts). An update runs this too, with
; ${isUpdated} set, and those stay: the app keeps its pending download, the app writes the
; rest again at its next start, and only a real uninstall should drop the login item.
!macro customUnInstall
  !ifmacrodef bulwarkThemeUninstallerPage
    !insertmacro bulwarkThemeUninstallerPage
  !endif
  ${ifNot} ${isUpdated}
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall-cleanup'
    DeleteRegValue HKCU "Software\RegisteredApplications" "Bulwark"
    DeleteRegKey HKCU "Software\Bulwark"
    DeleteRegKey HKCU "Software\Classes\Bulwark.Url.mailto"
    DeleteRegKey HKCU "Software\Classes\Bulwark.Url.webcal"
    DeleteRegKey HKCU "Software\Classes\Bulwark.File.eml"
    DeleteRegKey HKCU "Software\Classes\Bulwark.File.ics"
    DeleteRegKey HKCU "Software\Classes\Bulwark.File.vcf"
    DeleteRegKey HKCU "Software\Classes\bulwark"
    DeleteRegValue HKCU "Software\Classes\.eml\OpenWithProgids" "Bulwark.File.eml"
    DeleteRegValue HKCU "Software\Classes\.ics\OpenWithProgids" "Bulwark.File.ics"
    DeleteRegValue HKCU "Software\Classes\.vcf\OpenWithProgids" "Bulwark.File.vcf"
    ; "Open with", "Choose another app" and "Send to" (os-rules.ts OPEN_WITH_EXTENSIONS).
    DeleteRegKey HKCU "Software\Classes\Bulwark.File.attach"
    DeleteRegKey HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
    DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "Bulwark.File.attach"
    DeleteRegValue HKCU "Software\Classes\.doc\OpenWithProgids" "Bulwark.File.attach"
    DeleteRegValue HKCU "Software\Classes\.docx\OpenWithProgids" "Bulwark.File.attach"
    DeleteRegValue HKCU "Software\Classes\.xls\OpenWithProgids" "Bulwark.File.attach"
    DeleteRegValue HKCU "Software\Classes\.xlsx\OpenWithProgids" "Bulwark.File.attach"
    DeleteRegValue HKCU "Software\Classes\.ppt\OpenWithProgids" "Bulwark.File.attach"
    DeleteRegValue HKCU "Software\Classes\.pptx\OpenWithProgids" "Bulwark.File.attach"
    DeleteRegValue HKCU "Software\Classes\.odt\OpenWithProgids" "Bulwark.File.attach"
    DeleteRegValue HKCU "Software\Classes\.ods\OpenWithProgids" "Bulwark.File.attach"
    DeleteRegValue HKCU "Software\Classes\.odp\OpenWithProgids" "Bulwark.File.attach"
    DeleteRegValue HKCU "Software\Classes\.rtf\OpenWithProgids" "Bulwark.File.attach"
    DeleteRegValue HKCU "Software\Classes\.txt\OpenWithProgids" "Bulwark.File.attach"
    DeleteRegValue HKCU "Software\Classes\.csv\OpenWithProgids" "Bulwark.File.attach"
    DeleteRegValue HKCU "Software\Classes\.jpg\OpenWithProgids" "Bulwark.File.attach"
    DeleteRegValue HKCU "Software\Classes\.jpeg\OpenWithProgids" "Bulwark.File.attach"
    DeleteRegValue HKCU "Software\Classes\.png\OpenWithProgids" "Bulwark.File.attach"
    DeleteRegValue HKCU "Software\Classes\.gif\OpenWithProgids" "Bulwark.File.attach"
    DeleteRegValue HKCU "Software\Classes\.webp\OpenWithProgids" "Bulwark.File.attach"
    DeleteRegValue HKCU "Software\Classes\.heic\OpenWithProgids" "Bulwark.File.attach"
    DeleteRegValue HKCU "Software\Classes\.bmp\OpenWithProgids" "Bulwark.File.attach"
    DeleteRegValue HKCU "Software\Classes\.tif\OpenWithProgids" "Bulwark.File.attach"
    DeleteRegValue HKCU "Software\Classes\.tiff\OpenWithProgids" "Bulwark.File.attach"
    DeleteRegValue HKCU "Software\Classes\.svg\OpenWithProgids" "Bulwark.File.attach"
    DeleteRegValue HKCU "Software\Classes\.zip\OpenWithProgids" "Bulwark.File.attach"
    Delete "$APPDATA\Microsoft\Windows\SendTo\Bulwark (as attachment).lnk"
    DeleteRegKey HKCU "Software\Classes\CLSID\{7B1E4F2A-93C6-4D0E-A5B8-2F6C1D9E3A47}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Bulwark"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Bulwark"
    RMDir /r "$LOCALAPPDATA\Bulwark\os-files"
    ; Only when empty: a copy of an attachment someone still edits, and what the folder sync
    ; knows, stay with the profile. src/main/uninstall-cleanup.ts does the same for the MSI.
    RMDir "$LOCALAPPDATA\Bulwark\edit-files"
    RMDir "$LOCALAPPDATA\Bulwark\files-sync\state"
    RMDir "$LOCALAPPDATA\Bulwark\files-sync"
    RMDir "$LOCALAPPDATA\Bulwark"
    RMDir /r "$LOCALAPPDATA\bulwark-desktop-updater"
    ; Electron registers a COM server for toasts under a CLSID it may make up itself. Any
    ; that names this install goes.
    Push $R6
    Push $R7
    Push $R8
    StrCpy $R6 0
    ${Do}
      EnumRegKey $R7 HKCU "Software\Classes\CLSID" $R6
      ${If} $R7 == ""
        ${ExitDo}
      ${EndIf}
      ReadRegStr $R8 HKCU "Software\Classes\CLSID\$R7\LocalServer32" ""
      ${If} $R8 == "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      ${OrIf} $R8 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
        DeleteRegKey HKCU "Software\Classes\CLSID\$R7"
      ${Else}
        IntOp $R6 $R6 + 1
      ${EndIf}
    ${Loop}
    ; The Files drive letter's name and icon in "This PC" (src/main/files/drive-letter-label.ts):
    ; only where they are still this install's, a letter's key someone else set stays.
    StrCpy $R6 3
    ${Do}
      StrCpy $R7 "ABCDEFGHIJKLMNOPQRSTUVWXYZ" 1 $R6
      ${If} $R7 == ""
        ${ExitDo}
      ${EndIf}
      ReadRegStr $R8 HKCU "Software\Classes\Applications\Explorer.exe\Drives\$R7\DefaultIcon" ""
      ${If} $R8 == "$INSTDIR\resources\os-icons\bulwark.ico,0"
        ReadRegStr $R8 HKCU "Software\Classes\Applications\Explorer.exe\Drives\$R7\DefaultLabel" ""
        ${If} $R8 == "Bulwark Files"
        ${OrIf} $R8 == ""
          DeleteRegKey HKCU "Software\Classes\Applications\Explorer.exe\Drives\$R7\DefaultLabel"
          DeleteRegKey HKCU "Software\Classes\Applications\Explorer.exe\Drives\$R7\DefaultIcon"
          DeleteRegKey /ifempty HKCU "Software\Classes\Applications\Explorer.exe\Drives\$R7"
        ${EndIf}
      ${EndIf}
      IntOp $R6 $R6 + 1
    ${Loop}
    Pop $R8
    Pop $R7
    Pop $R6
  ${endIf}
  ; electron-builder removes the files right after this.
  !ifmacrodef bulwarkThemeUninstallFilesStep
    !insertmacro bulwarkThemeUninstallFilesStep
  !endif
!macroend
