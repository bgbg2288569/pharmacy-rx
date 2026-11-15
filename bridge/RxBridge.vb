' =====================================================================
' RxBridge — 本地藥局系統橋接程式（福原藥局 ODBC → 網頁）
' 在櫃台電腦背景執行，網頁輸入姓名時呼叫 http://localhost:5880/patients?q=王
' 由這支程式透過 ODBC 查藥局系統，回傳 JSON。資料只在本機與瀏覽器之間傳遞，不經過雲端。
'
' 專案：Windows Forms App (.NET Framework 4.8)，平台目標 x86（32 位元 ODBC 驅動）
' 參考：System.Web.Extensions（JavaScriptSerializer）
' 設定：與 exe 同資料夾的 RxBridge.ini
' Designed by Tom 蔡育霖藥師
' =====================================================================
Imports System.Collections.Generic
Imports System.Data.Odbc
Imports System.IO
Imports System.Linq
Imports System.Net
Imports System.Text
Imports System.Text.RegularExpressions
Imports System.Threading
Imports System.Web.Script.Serialization
Imports System.Windows.Forms
Imports System.Drawing
Imports System.Drawing.Drawing2D
Imports System.Drawing.Printing
Imports QRCoder

Module RxBridge

    Private ReadOnly Cfg As New Dictionary(Of String, String)(StringComparer.OrdinalIgnoreCase)
    Private Listener As HttpListener
    Private Tray As NotifyIcon
    Private ReadOnly Json As New JavaScriptSerializer()

    <STAThread>
    Sub Main()
        Dim created As Boolean
        Using mtx As New Mutex(True, "LinyaoRxBridge", created)
            If Not created Then Return    ' 已在執行
            LoadConfig()
            Application.EnableVisualStyles()
            BuildTray()
            Try
                StartServer()
                Tray.ShowBalloonTip(3000, "RxBridge", $"藥局系統橋接已啟動（埠 {Cfg("Port")}）", ToolTipIcon.Info)
            Catch ex As HttpListenerException
                MessageBox.Show($"無法啟動 http://localhost:{Cfg("Port")}/" & vbCrLf & ex.Message & vbCrLf & vbCrLf &
                                "請以系統管理員身分執行一次 setup_urlacl.bat。", "RxBridge", MessageBoxButtons.OK, MessageBoxIcon.Error)
                Return
            End Try
            Application.Run()
            Listener?.Stop()
            Tray.Visible = False
        End Using
    End Sub

    ' ---------------------------------------------------------------- 設定
    Private Sub LoadConfig()
        Cfg("Port") = "5880"
        Cfg("Name") = "福原藥局"
        Cfg("ConnectionString") = "DSN=ercrmis;UID=dba;ENP=2bf4d7163b8faf50e6e793f7f296ed57;"
        Cfg("AllowedOrigins") = "*"
        Cfg("MaxRows") = "20"
        Cfg("QueryName") = "" : Cfg("QueryPhone") = "" : Cfg("QueryIdno") = "" : Cfg("QueryBirth") = ""
        Cfg("NamePattern") = "%{q}%"
        Cfg("PhonePattern") = "{q}%"
        Dim path = IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "RxBridge.ini")
        If Not File.Exists(path) Then Return
        Dim key As String = Nothing
        For Each raw In File.ReadAllLines(path, Encoding.UTF8)
            Dim line = raw.TrimEnd()
            If line.StartsWith(";") OrElse line.StartsWith("#") OrElse line.StartsWith("[") Then Continue For
            ' 支援多行：以空白開頭的行接續上一個 key
            If key IsNot Nothing AndAlso raw.Length > 0 AndAlso Char.IsWhiteSpace(raw(0)) Then
                Cfg(key) &= " " & line.Trim()
                Continue For
            End If
            Dim i = line.IndexOf("="c)
            If i <= 0 Then key = Nothing : Continue For
            key = line.Substring(0, i).Trim()
            Cfg(key) = line.Substring(i + 1).Trim()
        Next
    End Sub

    ' ---------------------------------------------------------------- 系統匣
    Private Sub BuildTray()
        Tray = New NotifyIcon() With {.Icon = AppIcon(), .Text = "RxBridge 藥局系統橋接", .Visible = True}
        Dim menu As New ContextMenuStrip()
        menu.Items.Add("測試查詢…", Nothing, Sub() TestQuery())
        menu.Items.Add("測試列印貼紙", Nothing, Sub() TestPrint())
        menu.Items.Add("重新載入設定", Nothing, Sub()
                                               LoadConfig()
                                               Tray.ShowBalloonTip(2000, "RxBridge", "設定已重新載入", ToolTipIcon.Info)
                                           End Sub)
        menu.Items.Add("結束", Nothing, Sub() Application.Exit())
        Tray.ContextMenuStrip = menu
    End Sub

    ' 系統匣圖示：與寄單網頁相同的雙圓圖示（exe 旁的 RxBridge.ico；找不到就用 exe 內嵌圖示）
    Private Function AppIcon() As Drawing.Icon
        Try
            Dim f = IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "RxBridge.ico")
            If File.Exists(f) Then Return New Drawing.Icon(f, SystemInformation.SmallIconSize)
            Return Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath)
        Catch
            Return Drawing.SystemIcons.Application
        End Try
    End Function

    Private Sub TestQuery()
        Dim q = Microsoft.VisualBasic.Interaction.InputBox("輸入姓名、電話、民國生日或身分證字號：", "RxBridge 測試", "王")
        If String.IsNullOrWhiteSpace(q) Then Return
        Try
            Dim rows = SearchPatients(q)
            MessageBox.Show($"取得 {rows.Count} 筆" & vbCrLf & Json.Serialize(rows), "RxBridge 測試")
        Catch ex As Exception
            MessageBox.Show(ex.Message, "RxBridge 測試失敗", MessageBoxButtons.OK, MessageBoxIcon.Error)
        End Try
    End Sub

    ' ---------------------------------------------------------------- HTTP
    Private Sub StartServer()
        Listener = New HttpListener()
        Listener.Prefixes.Add($"http://localhost:{Cfg("Port")}/")
        Listener.Prefixes.Add($"http://127.0.0.1:{Cfg("Port")}/")
        Listener.Start()
        Dim t As New Thread(Sub()
                                While Listener.IsListening
                                    Try
                                        Dim ctx = Listener.GetContext()
                                        ThreadPool.QueueUserWorkItem(Sub() Handle(ctx))
                                    Catch
                                        Exit While
                                    End Try
                                End While
                            End Sub) With {.IsBackground = True}
        t.Start()
    End Sub

    Private Sub Handle(ctx As HttpListenerContext)
        Dim req = ctx.Request, res = ctx.Response
        Try
            ' CORS + Chrome Private Network Access（https 網頁呼叫 localhost 需要）
            Dim origin = req.Headers("Origin")
            Dim allowed = Cfg("AllowedOrigins")
            If origin IsNot Nothing AndAlso (allowed = "*" OrElse allowed.Split(","c).Any(Function(o) o.Trim().Equals(origin, StringComparison.OrdinalIgnoreCase))) Then
                res.AddHeader("Access-Control-Allow-Origin", origin)
                res.AddHeader("Vary", "Origin")
            ElseIf origin IsNot Nothing Then
                Reply(res, 403, New With {.error = "origin not allowed"}) : Return
            End If
            res.AddHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            res.AddHeader("Access-Control-Allow-Headers", "*")
            res.AddHeader("Access-Control-Allow-Private-Network", "true")
            If req.HttpMethod = "OPTIONS" Then res.StatusCode = 204 : res.Close() : Return

            Select Case req.Url.AbsolutePath.TrimEnd("/"c).ToLowerInvariant()
                Case "/health"
                    Reply(res, 200, New With {.ok = True, .name = Cfg("Name"), .version = "1.4.0"})
                Case "/patients"
                    ' 注意：不能用 req.QueryString —— .NET Framework 會用系統預設編碼（Big5）解碼網址，
                    ' 中文會變亂碼，送進 ODBC 後變成一串 ?，反而查到一堆含 ? 的姓名。這裡自己用 UTF-8 解碼。
                    Dim q = QueryParam(req.Url.Query, "q").Trim()
                    If q.Length = 0 Then Reply(res, 200, New List(Of Object)) : Return
                    Reply(res, 200, SearchPatients(q))
                Case "/print-label"
                    If req.HttpMethod <> "POST" Then Reply(res, 405, New With {.error = "請用 POST"}) : Return
                    Dim body As String
                    Using sr As New StreamReader(req.InputStream, Encoding.UTF8)
                        body = sr.ReadToEnd()
                    End Using
                    Dim obj = Json.Deserialize(Of Dictionary(Of String, Object))(body)
                    Dim labelObj As Object = Nothing
                    If obj IsNot Nothing Then obj.TryGetValue("label", labelObj)
                    Dim label = TryCast(labelObj, Dictionary(Of String, Object))
                    If label Is Nothing Then Reply(res, 400, New With {.error = "缺少 label"}) : Return
                    Dim copies = 1
                    If obj.ContainsKey("copies") Then copies = Math.Max(1, Math.Min(10, CInt(Val(obj("copies")))))
                    Dim printer = PrintLabel(label, copies)
                    Reply(res, 200, New With {.ok = True, .printer = printer})
                Case Else
                    Reply(res, 404, New With {.error = "not found"})
            End Select
        Catch ex As Exception
            Try : Reply(res, 500, New With {.error = ex.Message}) : Catch : End Try
        End Try
    End Sub

    ' 用 UTF-8 解析網址參數（?q=%E8%94%A1... → 蔡...）
    Private Function QueryParam(query As String, name As String) As String
        If String.IsNullOrEmpty(query) Then Return ""
        For Each part In query.TrimStart("?"c).Split("&"c)
            Dim i = part.IndexOf("="c)
            Dim k = If(i < 0, part, part.Substring(0, i))
            If Uri.UnescapeDataString(k.Replace("+", " ")) = name Then
                Return If(i < 0, "", Uri.UnescapeDataString(part.Substring(i + 1).Replace("+", " ")))
            End If
        Next
        Return ""
    End Function

    Private Sub Reply(res As HttpListenerResponse, status As Integer, body As Object)
        Dim bytes = Encoding.UTF8.GetBytes(Json.Serialize(body))
        res.StatusCode = status
        res.ContentType = "application/json; charset=utf-8"
        res.ContentLength64 = bytes.Length
        res.OutputStream.Write(bytes, 0, bytes.Length)
        res.Close()
    End Sub

    ' ---------------------------------------------------------------- ODBC 查詢
    ' 依輸入內容選用不同查詢（RxBridge.ini）：
    '   身分證／居留證號（A123456789）→ QueryIdno，參數為完整號碼（大寫）
    '   民國生日（750312、0750312、1000711、75/3/12）→ QueryBirth，參數轉成西元 yyyy/MM/dd
    '   全數字 → QueryPhone，參數套 PhonePattern（例：0912%）
    '     6～7 碼且剛好是合理日期時（例：0750312），生日、電話兩種都查，結果合併
    '   其他 → QueryName，參數套 NamePattern（例：%王%）
    ' 查詢中每個 ? 都綁同一個值。欄位請用別名：
    '   ext_id（客戶代號）、name、idno、birthday、tel1、tel2、memo（sa110.allergy）
    ' 回傳前處理：身分證完整回傳（僅本機傳輸）；電話去掉非數字，手機（09）優先；生日轉成 yyyy-MM-dd；
    '   同一客戶代號有多筆家庭健康檔時合併成一筆，備註串在一起。
    Private ReadOnly IdnoRx As New Regex("^[A-Za-z][A-Da-d0-9][0-9]{8}$")

    Private Function SearchPatients(q As String) As List(Of Dictionary(Of String, Object))
        Dim jobs As New List(Of KeyValuePair(Of String, String))
        Dim birth = RocBirth(q)
        If IdnoRx.IsMatch(q) Then
            jobs.Add(New KeyValuePair(Of String, String)("QueryIdno", q.ToUpperInvariant()))
        ElseIf q.All(AddressOf Char.IsDigit) Then
            If birth <> "" Then jobs.Add(New KeyValuePair(Of String, String)("QueryBirth", birth))
            jobs.Add(New KeyValuePair(Of String, String)("QueryPhone", Cfg("PhonePattern").Replace("{q}", q)))
        ElseIf birth <> "" Then
            jobs.Add(New KeyValuePair(Of String, String)("QueryBirth", birth))
        Else
            jobs.Add(New KeyValuePair(Of String, String)("QueryName", Cfg("NamePattern").Replace("{q}", SafeLike(q))))
        End If
        Dim max = Math.Max(1, Math.Min(200, CInt(Val(Cfg("MaxRows")))))
        Dim byId As New Dictionary(Of String, Dictionary(Of String, Object))
        Dim list As New List(Of Dictionary(Of String, Object))
        Using cn As New OdbcConnection(Cfg("ConnectionString"))
            cn.Open()
            For Each job In jobs
                Dim sql = If(Cfg.ContainsKey(job.Key), Cfg(job.Key), "")
                If String.IsNullOrWhiteSpace(sql) Then Throw New ApplicationException($"RxBridge.ini 尚未設定 {job.Key}")
                RunQuery(cn, sql, job.Value, byId, list, max)
            Next
        End Using
        Return list
    End Function

    Private Sub RunQuery(cn As OdbcConnection, sql As String, param As String,
                         byId As Dictionary(Of String, Dictionary(Of String, Object)),
                         list As List(Of Dictionary(Of String, Object)), max As Integer)
        Using cmd As New OdbcCommand(sql, cn)
            cmd.CommandTimeout = 5
            For i = 1 To sql.Count(Function(c) c = "?"c)
                cmd.Parameters.Add(New OdbcParameter() With {.Value = param})
            Next
            Using rd = cmd.ExecuteReader()
                While rd.Read()
                    Dim raw As New Dictionary(Of String, String)(StringComparer.OrdinalIgnoreCase)
                    For c = 0 To rd.FieldCount - 1
                        Dim v = rd.GetValue(c)
                        raw(rd.GetName(c)) = If(IsDBNull(v), "",
                            If(TypeOf v Is Date, CDate(v).ToString("yyyy-MM-dd"), v.ToString().Trim()))
                    Next
                    Dim id = Get1(raw, "ext_id")
                    Dim memo = Get1(raw, "memo")
                    If id <> "" AndAlso byId.ContainsKey(id) Then
                        ' 同一位客戶的其他家庭健康檔（或另一種查詢重複查到）：備註合併
                        Dim old = CStr(byId(id)("memo"))
                        If memo <> "" AndAlso Not old.Contains(memo) Then byId(id)("memo") = If(old = "", memo, old & "；" & memo)
                        Continue While
                    End If
                    If list.Count >= max Then Continue While
                    Dim phones As New List(Of String)
                    For Each t In New String() {Get1(raw, "tel1"), Get1(raw, "tel2")}
                        Dim d = New String(t.Where(AddressOf Char.IsDigit).ToArray())
                        If d.Length >= 7 AndAlso Not phones.Contains(d) Then phones.Add(d)
                    Next
                    Dim mobile = phones.FirstOrDefault(Function(t) t.StartsWith("09"))
                    Dim row As New Dictionary(Of String, Object) From {
                        {"ext_id", id},
                        {"name", Get1(raw, "name")},
                        {"birthday", NormDate(Get1(raw, "birthday"))},
                        {"phone", If(mobile, If(phones.FirstOrDefault(), ""))},
                        {"phones", phones},
                        {"idno", Get1(raw, "idno").ToUpperInvariant()},
                        {"memo", memo}
                    }
                    list.Add(row)
                    If id <> "" Then byId(id) = row
                End While
            End Using
        End Using
    End Sub

    ' 藥局系統是 Big5（950），Big5 沒有的字（例：㚬、堃的異體字）經 ODBC 送出時會變成 ?，
    ' 會比對到所有姓名含「?」的客戶。這類字改用 LIKE 的單字萬用字元 _ 代替（任一字都符合）。
    ' 另外把使用者輸入的 ?、%、_ 也當成萬用字元處理，避免整批亂碼姓名被查出來。
    Private Function SafeLike(q As String) As String
        Dim enc As Encoding
        Try
            enc = Encoding.GetEncoding(CInt(Val(If(Cfg.ContainsKey("CodePage"), Cfg("CodePage"), "950"))),
                                       EncoderFallback.ExceptionFallback, DecoderFallback.ExceptionFallback)
        Catch
            Return q
        End Try
        Dim sb As New StringBuilder()
        For Each ch In q
            If ch = "?"c OrElse ch = "%"c OrElse ch = "_"c Then sb.Append("_"c) : Continue For
            Try
                enc.GetBytes(New Char() {ch})
                sb.Append(ch)
            Catch
                sb.Append("_"c)
            End Try
        Next
        Return sb.ToString()
    End Function

    ' 民國生日 → 西元 yyyy/MM/dd（與 sa100.birthday 格式相同）；不是合理日期回傳空字串
    '   750312、0750312、1000711（年 2～3 碼＋月日各 2 碼），或 75/3/12、075/03/12、75.3.12
    Private Function RocBirth(q As String) As String
        Dim y As Integer, mo As Integer, d As Integer
        Dim m = Regex.Match(q.Trim(), "^(\d{2,3})(\d{2})(\d{2})$")
        If Not m.Success Then m = Regex.Match(q.Trim(), "^(\d{1,3})[/\-.](\d{1,2})[/\-.](\d{1,2})$")
        If Not m.Success Then Return ""
        y = CInt(m.Groups(1).Value) + 1911 : mo = CInt(m.Groups(2).Value) : d = CInt(m.Groups(3).Value)
        If y > Date.Today.Year OrElse mo < 1 OrElse mo > 12 OrElse d < 1 OrElse d > Date.DaysInMonth(y, mo) Then Return ""
        Return $"{y:0000}/{mo:00}/{d:00}"
    End Function

    Private Function Get1(d As Dictionary(Of String, String), k As String) As String
        Dim v As String = Nothing
        Return If(d.TryGetValue(k, v), If(v, ""), "")
    End Function

    ' 2001/05/03、2001-5-3、20010503 → 2001-05-03；無法判讀回傳空字串
    Private Function NormDate(s As String) As String
        If String.IsNullOrWhiteSpace(s) Then Return ""
        Dim digits = s.Trim()
        Dim m = Regex.Match(digits, "^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})")
        If m.Success Then Return $"{m.Groups(1).Value}-{CInt(m.Groups(2).Value):00}-{CInt(m.Groups(3).Value):00}"
        m = Regex.Match(digits, "^(\d{4})(\d{2})(\d{2})$")
        If m.Success Then Return $"{m.Groups(1).Value}-{m.Groups(2).Value}-{m.Groups(3).Value}"
        Return ""
    End Function


    ' ---------------------------------------------------------------- 4×3 寄單貼紙列印
    ' 版面與網頁相同：左 QR＋寄單編號；右 姓名、醫院、科別、電話、通知方式；粗線下方 ➋12/02 ➌12/30
    ' 印表機：RxBridge.ini 的 LabelPrinter（空白＝Windows 預設印表機）；尺寸：LabelWidthMm × LabelHeightMm
    Private ReadOnly PrintLock As New Object()

    Private Function PrintLabel(label As Dictionary(Of String, Object), copies As Integer) As String
        SyncLock PrintLock
            Dim w = CSng(Val(If(Cfg.ContainsKey("LabelWidthMm"), Cfg("LabelWidthMm"), "40")))
            Dim h = CSng(Val(If(Cfg.ContainsKey("LabelHeightMm"), Cfg("LabelHeightMm"), "30")))
            Using doc As New PrintDocument()
                Dim pn = If(Cfg.ContainsKey("LabelPrinter"), Cfg("LabelPrinter"), "").Trim()
                If pn <> "" Then
                    doc.PrinterSettings.PrinterName = pn
                    If Not doc.PrinterSettings.IsValid Then Throw New ApplicationException($"找不到印表機「{pn}」，請確認 RxBridge.ini 的 LabelPrinter")
                End If
                doc.DocumentName = "寄單貼紙 " & S(label, "order_no")
                doc.PrinterSettings.Copies = CShort(copies)
                ' 紙張大小以 1/100 英吋為單位
                doc.DefaultPageSettings.PaperSize = New PaperSize("RxLabel", CInt(Math.Round(w / 25.4 * 100)), CInt(Math.Round(h / 25.4 * 100)))
                doc.DefaultPageSettings.Margins = New Margins(0, 0, 0, 0)
                doc.DefaultPageSettings.Landscape = False
                doc.OriginAtMargins = False
                AddHandler doc.PrintPage, Sub(sender As Object, e As PrintPageEventArgs) DrawLabel(e.Graphics, label, w, h)
                doc.Print()
                Return doc.PrinterSettings.PrinterName
            End Using
        End SyncLock
    End Function

    Private Function S(d As Dictionary(Of String, Object), k As String) As String
        Dim v As Object = Nothing
        Return If(d IsNot Nothing AndAlso d.TryGetValue(k, v) AndAlso v IsNot Nothing, v.ToString(), "")
    End Function

    ' 依可用寬度自動縮小字級（mm）
    Private Function FitFont(g As Graphics, text As String, family As String, style As FontStyle, maxMm As Single, widthMm As Single, Optional minMm As Single = 1.6F) As Font
        Dim size = maxMm
        Do
            Dim f As New Font(family, size, style, GraphicsUnit.Millimeter)
            If size <= minMm OrElse g.MeasureString(text, f, PointF.Empty, StringFormat.GenericTypographic).Width <= widthMm Then Return f
            f.Dispose()
            size -= 0.1F
        Loop
    End Function

    Private Sub DrawLabel(g As Graphics, label As Dictionary(Of String, Object), w As Single, h As Single)
        g.PageUnit = GraphicsUnit.Millimeter
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit
        g.SmoothingMode = SmoothingMode.HighQuality
        Dim cjk = If(Cfg.ContainsKey("LabelFont"), Cfg("LabelFont"), "Microsoft JhengHei")
        Dim fmt = StringFormat.GenericTypographic
        Dim offX = CSng(Val(If(Cfg.ContainsKey("LabelOffsetXmm"), Cfg("LabelOffsetXmm"), "0")))
        Dim offY = CSng(Val(If(Cfg.ContainsKey("LabelOffsetYmm"), Cfg("LabelOffsetYmm"), "0")))
        g.TranslateTransform(offX, offY)

        Const L As Single = 1.5F, T As Single = 1.0F
        Dim innerW = w - L * 2
        Dim fillsH = 6.4F                               ' 下方領藥日區高度
        Dim lineY = h - 0.8F - fillsH                   ' 粗線位置
        Dim qrSize = Math.Min(15.0F, lineY - T - 3.0F)  ' QR 邊長（下方留編號空間）

        ' --- QR ＋ 寄單編號 ---
        Dim orderNo = S(label, "order_no")
        If orderNo <> "" Then
            Using gen As New QRCodeGenerator()
                Using data = gen.CreateQrCode(orderNo, QRCodeGenerator.ECCLevel.M)
                    Using qr As New QRCode(data)
                        Using bmp = qr.GetGraphic(8, Color.Black, Color.White, False)
                            g.InterpolationMode = InterpolationMode.NearestNeighbor
                            g.PixelOffsetMode = PixelOffsetMode.Half
                            g.DrawImage(bmp, New RectangleF(L, T, qrSize, qrSize))
                        End Using
                    End Using
                End Using
            End Using
        End If
        Dim noText = If(S(label, "order_no_fmt") <> "", S(label, "order_no_fmt"), orderNo)
        Using f = FitFont(g, noText, "Arial", FontStyle.Bold, 2.25F, qrSize + 0.5F)
            Dim sz = g.MeasureString(noText, f, PointF.Empty, fmt)
            g.DrawString(noText, f, Brushes.Black, L + (qrSize - sz.Width) / 2, T + qrSize + 0.3F, fmt)
        End Using

        ' --- 右側文字欄 ---
        Dim rx = L + qrSize + 1.3F
        Dim rw = w - L - rx
        Dim lines As New List(Of Tuple(Of String, String, FontStyle, Single))
        lines.Add(Tuple.Create(S(label, "patient_name"), cjk, FontStyle.Bold, 5.6F))
        For Each k In {"hospital", "dept", "phone", "notify"}
            Dim t = S(label, k)
            If t <> "" Then lines.Add(Tuple.Create(t, If(k = "phone", "Arial", cjk), FontStyle.Bold, 3.0F))
        Next
        ' 先算總高度，垂直置中於 QR 區
        Dim fonts = lines.Select(Function(ln) FitFont(g, ln.Item1, ln.Item2, ln.Item3, ln.Item4, rw)).ToList()
        Dim heights = fonts.Select(Function(ft) ft.GetHeight(g) * 0.98F).ToList()
        Dim y = T + Math.Max(0, (lineY - T - 0.4F - heights.Sum()) / 2)
        For i = 0 To lines.Count - 1
            g.DrawString(lines(i).Item1, fonts(i), Brushes.Black, rx, y, fmt)
            y += heights(i)
            fonts(i).Dispose()
        Next

        ' --- 粗線 ---
        Using pen As New Pen(Color.Black, 0.55F)
            g.DrawLine(pen, L, lineY, w - L, lineY)
        End Using

        ' --- 領藥日：➊➋➌ + MM/DD（平均分配寬度） ---
        Dim fillsObj As Object = Nothing
        label.TryGetValue("fills", fillsObj)
        Dim fills = TryCast(fillsObj, System.Collections.IList)
        If fills Is Nothing OrElse fills.Count = 0 Then Return
        Dim marks = New String() {"", "➊", "➋", "➌"}
        Dim colW = innerW / fills.Count
        Dim size = Math.Min(5.2F, (colW - 1.2F) / 3.8F)
        Using fNum As New Font("Arial", size, FontStyle.Bold, GraphicsUnit.Millimeter),
              fMark As New Font("Segoe UI Symbol", size * 1.05F, FontStyle.Regular, GraphicsUnit.Millimeter)
            For i = 0 To fills.Count - 1
                Dim fl = TryCast(fills(i), Dictionary(Of String, Object))
                Dim seq = CInt(Val(S(fl, "seq")))
                Dim mark = If(seq >= 1 AndAlso seq <= 3, marks(seq), seq.ToString())
                Dim md = S(fl, "md")
                Dim mw = g.MeasureString(mark, fMark, PointF.Empty, fmt).Width
                Dim dw = g.MeasureString(md, fNum, PointF.Empty, fmt).Width
                Dim px = L + colW * i + (colW - mw - 0.6F - dw) / 2
                Dim ty = lineY + 0.6F + (fillsH - 0.6F - fNum.GetHeight(g)) / 2
                g.DrawString(mark, fMark, Brushes.Black, px, ty - size * 0.02F, fmt)
                g.DrawString(md, fNum, Brushes.Black, px + mw + 0.6F, ty, fmt)
            Next
        End Using
    End Sub

    ' 測試列印（系統匣選單）
    Private Sub TestPrint()
        Try
            Dim label As New Dictionary(Of String, Object) From {
                {"order_no", "26111400057"}, {"order_no_fmt", "261114-0005-7"}, {"patient_name", "測試病人"},
                {"hospital", "台大"}, {"dept", "心臟血管內科"}, {"phone", "0912345678"}, {"notify", "LINE通知"},
                {"fills", New ArrayList From {
                    New Dictionary(Of String, Object) From {{"seq", 2}, {"md", "12/02"}},
                    New Dictionary(Of String, Object) From {{"seq", 3}, {"md", "12/30"}}}}}
            Dim p = PrintLabel(label, 1)
            Tray.ShowBalloonTip(2000, "RxBridge", $"已送出測試貼紙到「{p}」", ToolTipIcon.Info)
        Catch ex As Exception
            MessageBox.Show(ex.Message, "RxBridge 測試列印失敗", MessageBoxButtons.OK, MessageBoxIcon.Error)
        End Try
    End Sub

End Module
