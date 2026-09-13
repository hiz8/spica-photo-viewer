; Spec: docs/superpowers/specs/2026-09-12-file-type-icon-design.md
;
; Tauri の APP_ASSOCIATE は DefaultIcon を "exe,0" 固定で書く。設定で変える
; 手段が無いので、関連付け作成の後に走る POSTINSTALL で上書きする。

; (F12) アンインストールを経ない上書きインストールでは APP_ASSOCIATE が再実行され、
; 自分の ProgID を _backup に退避し直して前の持ち主を失う。既定値が自分の ProgID
; なら _backup の値へ戻してから APP_ASSOCIATE に渡す。
!macro SPICA_UNDO_OWN_ASSOCIATION EXT PROGID
  ReadRegStr $R0 SHCTX "Software\Classes\.${EXT}" ""
  ${If} $R0 == "${PROGID}"
    ReadRegStr $R0 SHCTX "Software\Classes\.${EXT}" "${PROGID}_backup"
    WriteRegStr SHCTX "Software\Classes\.${EXT}" "" $R0
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; フックはテンプレートの途中に展開されるので、使うレジスタは元に戻す。
  Push $R0
  ; jpg と jpeg は ProgID を共有するが、_backup は拡張子キーごとに別に持つ。
  !insertmacro SPICA_UNDO_OWN_ASSOCIATION "jpg" "SpicaPhotoViewer.jpeg"
  !insertmacro SPICA_UNDO_OWN_ASSOCIATION "jpeg" "SpicaPhotoViewer.jpeg"
  !insertmacro SPICA_UNDO_OWN_ASSOCIATION "png" "SpicaPhotoViewer.png"
  !insertmacro SPICA_UNDO_OWN_ASSOCIATION "webp" "SpicaPhotoViewer.webp"
  !insertmacro SPICA_UNDO_OWN_ASSOCIATION "gif" "SpicaPhotoViewer.gif"
  Pop $R0
!macroend

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

; (F13) APP_UNASSOCIATE は _backup 値を残し、既定値も空文字で書き戻すだけで消さない。
; 値の上ではインストール前の状態に戻す。
!macro SPICA_CLEAN_EXTENSION EXT PROGID
  DeleteRegValue SHCTX "Software\Classes\.${EXT}" "${PROGID}_backup"
  ReadRegStr $R0 SHCTX "Software\Classes\.${EXT}" ""
  ${If} $R0 == ""
    DeleteRegValue SHCTX "Software\Classes\.${EXT}" ""
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; (F3) ProgID 側は APP_UNASSOCIATE がキーごと消すので触らない。
  Push $R0
  !insertmacro SPICA_CLEAN_EXTENSION "jpg" "SpicaPhotoViewer.jpeg"
  !insertmacro SPICA_CLEAN_EXTENSION "jpeg" "SpicaPhotoViewer.jpeg"
  !insertmacro SPICA_CLEAN_EXTENSION "png" "SpicaPhotoViewer.png"
  !insertmacro SPICA_CLEAN_EXTENSION "webp" "SpicaPhotoViewer.webp"
  !insertmacro SPICA_CLEAN_EXTENSION "gif" "SpicaPhotoViewer.gif"
  Pop $R0
  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\DefaultIcon"
  ; Windows が作った shell\open\command が残っていればキーは消さない（§8）。
  DeleteRegKey /ifempty SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  !insertmacro UPDATEFILEASSOC
!macroend
