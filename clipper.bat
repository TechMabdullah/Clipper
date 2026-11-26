@echo off
chcp 65001 >nul
set PYTHONUTF8=1
title Clipper Studio — Terminal Control
python "%~dp0clipper_tui.py" %*
