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
Imports System.Threading
Imports System.Web.Script.Serialization
Imports System.Windows.Forms

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
        Cfg("Query") = ""
        Cfg("NamePattern") = "{q}%"
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
        Tray = New NotifyIcon() With {.Icon = Drawing.SystemIcons.Application, .Text = "RxBridge 藥局系統橋接", .Visible = True}
        Dim menu As New ContextMenuStrip()
        menu.Items.Add("測試查詢…", Nothing, Sub() TestQuery())
        menu.Items.Add("重新載入設定", Nothing, Sub()
                                               LoadConfig()
                                               Tray.ShowBalloonTip(2000, "RxBridge", "設定已重新載入", ToolTipIcon.Info)
                                           End Sub)
        menu.Items.Add("結束", Nothing, Sub() Application.Exit())
        Tray.ContextMenuStrip = menu
    End Sub

    Private Sub TestQuery()
        Dim q = Microsoft.VisualBasic.Interaction.InputBox("輸入姓名或電話：", "RxBridge 測試", "王")
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
            res.AddHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
            res.AddHeader("Access-Control-Allow-Headers", "*")
            res.AddHeader("Access-Control-Allow-Private-Network", "true")
            If req.HttpMethod = "OPTIONS" Then res.StatusCode = 204 : res.Close() : Return

            Select Case req.Url.AbsolutePath.TrimEnd("/"c).ToLowerInvariant()
                Case "/health"
                    Reply(res, 200, New With {.ok = True, .name = Cfg("Name"), .version = "1.0.0"})
                Case "/patients"
                    Dim q = If(req.QueryString("q"), "").Trim()
                    If q.Length = 0 Then Reply(res, 200, New List(Of Object)) : Return
                    Reply(res, 200, SearchPatients(q))
                Case Else
                    Reply(res, 404, New With {.error = "not found"})
            End Select
        Catch ex As Exception
            Try : Reply(res, 500, New With {.error = ex.Message}) : Catch : End Try
        End Try
    End Sub

    Private Sub Reply(res As HttpListenerResponse, status As Integer, body As Object)
        Dim bytes = Encoding.UTF8.GetBytes(Json.Serialize(body))
        res.StatusCode = status
        res.ContentType = "application/json; charset=utf-8"
        res.ContentLength64 = bytes.Length
        res.OutputStream.Write(bytes, 0, bytes.Length)
        res.Close()
    End Sub

    ' ---------------------------------------------------------------- ODBC 查詢
    ' Query 中的 ? 依序綁定：每個 ? 都綁同一個值；數字輸入用 PhonePattern，其餘用 NamePattern
    ' 欄位請用別名：name, phone, ext_id, birthday, last_visit（沒有的欄位可省略）
    Private Function SearchPatients(q As String) As List(Of Dictionary(Of String, Object))
        Dim sql = Cfg("Query")
        If String.IsNullOrWhiteSpace(sql) Then Throw New ApplicationException("RxBridge.ini 尚未設定 Query")
        Dim isNum = q.All(AddressOf Char.IsDigit)
        Dim pattern = If(isNum, Cfg("PhonePattern"), Cfg("NamePattern")).Replace("{q}", q)
        Dim max = Math.Max(1, Math.Min(50, CInt(Val(Cfg("MaxRows")))))
        Dim list As New List(Of Dictionary(Of String, Object))
        Using cn As New OdbcConnection(Cfg("ConnectionString"))
            cn.Open()
            Using cmd As New OdbcCommand(sql, cn)
                cmd.CommandTimeout = 5
                For i = 1 To sql.Count(Function(c) c = "?"c)
                    cmd.Parameters.AddWithValue("p" & i, pattern)
                Next
                Using rd = cmd.ExecuteReader()
                    While rd.Read() AndAlso list.Count < max
                        Dim row As New Dictionary(Of String, Object)
                        For c = 0 To rd.FieldCount - 1
                            Dim v = rd.GetValue(c)
                            row(rd.GetName(c).ToLowerInvariant()) = If(IsDBNull(v), "",
                                If(TypeOf v Is Date, CDate(v).ToString("yyyy-MM-dd"), v.ToString().Trim()))
                        Next
                        list.Add(row)
                    End While
                End Using
            End Using
        End Using
        Return list
    End Function

End Module
