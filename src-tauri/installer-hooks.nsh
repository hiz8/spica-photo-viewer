; Spec: docs/superpowers/specs/2026-09-12-file-type-icon-design.md
;
; Tauri の APP_ASSOCIATE は DefaultIcon を "exe,0" 固定で書く。設定で変える
; 手段が無いので、関連付け作成の後に走る POSTINSTALL で上書きする。
;
; (F10) ${MAINBINARYNAME} はこの .nsh の !include より後で !define される。
; トップレベルでは解決できないが、マクロ本体は !insertmacro 時に展開される。
!macro SPICA_WRITE_FILE_TYPE_ICON KEY
  WriteRegStr SHCTX "${KEY}\DefaultIcon" "" '"$INSTDIR\${MAINBINARYNAME}.exe",-32513'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro SPICA_WRITE_FILE_TYPE_ICON "Software\Classes\SpicaPhotoViewer.jpeg"
  !insertmacro SPICA_WRITE_FILE_TYPE_ICON "Software\Classes\SpicaPhotoViewer.png"
  !insertmacro SPICA_WRITE_FILE_TYPE_ICON "Software\Classes\SpicaPhotoViewer.webp"
  !insertmacro SPICA_WRITE_FILE_TYPE_ICON "Software\Classes\SpicaPhotoViewer.gif"
  ; 「プログラムから開く」で既定にされた場合、UserChoice はこの ProgID を指す。
  !insertmacro SPICA_WRITE_FILE_TYPE_ICON "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  ; (F4) テンプレートは SHChangeNotify を発行しないので自前で呼ぶ。
  !insertmacro UPDATEFILEASSOC
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; (F3) ProgID 側は APP_UNASSOCIATE がキーごと消すので触らない。
  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\DefaultIcon"
  !insertmacro UPDATEFILEASSOC
!macroend
