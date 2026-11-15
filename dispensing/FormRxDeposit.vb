' =====================================================================
' FormRxDeposit — 調劑輸出程式「建立寄單」確認視窗
' 從處方 XML 帶入資料 → 藥師確認／修改（電話、通知方式、領藥日…）→ 確定後才送到處方寄單系統
' 送出成功後交給本機 RxBridge 列印 4×3 寄單貼紙
'
' 需要的參考：System.Net.Http、System.Web.Extensions（JavaScriptSerializer）
' 本檔案不需要設計工具檔（控制項都在程式裡建立），加入專案即可使用
' Designed by Tom 蔡育霖藥師
' =====================================================================
Imports System.Drawing
Imports System.Globalization
Imports System.Linq
Imports System.Net.Http
Imports System.Text
Imports System.Threading.Tasks
Imports System.Web.Script.Serialization
Imports System.Windows.Forms
Imports System.Xml

Public Class FormRxDeposit
    Inherits Form

    ' ---- 由 Form1 設定 ----
    Public Property ApiUrl As String = ""        ' https://<專案代碼>.supabase.co/rest/v1/rpc/rx_intake
    Public Property AnonKey As String = ""       ' Supabase anon key
    Public Property ApiKey As String = ""        ' 門市 API 金鑰 rxk_...
    Public Property BridgeUrl As String = "http://localhost:5880"
    ''' <summary>送出成功後的寄單編號（11 碼），取消為空字串</summary>
    Public Property CreatedOrderNo As String = ""

    Private clientRef As String = ""
    Private extPatientId As String = ""
    Private Shared ReadOnly Http As New HttpClient() With {.Timeout = TimeSpan.FromSeconds(12)}
    Private ReadOnly Js As New JavaScriptSerializer()
    Private busy As Boolean = False

    ' ---- 控制項 ----
    Private txtName, txtBirth, txtHospCode, txtHospName, txtDeptCode, txtDeptName, txtNote, txtStaff As TextBox
    Private cboPhone As ComboBox
    Private chkLine, chkSms, chkTel, chkSelf, chkPrint As CheckBox
    Private txtDisp As TextBox
    Private numDays, numCur, numTotal, numLead As NumericUpDown
    Private txtFill(3) As TextBox                 ' 1～3 次領藥日（民國 1151202）
    Private lblMemo, lblWarn, lblStatus, lblStore As Label
    Private btnCheck, btnOk, btnCancel As Button

    Public Sub New()
        Text = "建立寄單（送到處方寄單系統）"
        Font = New Font("Microsoft JhengHei", 11.0F)
        StartPosition = FormStartPosition.CenterParent
        FormBorderStyle = FormBorderStyle.FixedDialog
        MaximizeBox = False : MinimizeBox = False
        ClientSize = New Size(760, 640)
        KeyPreview = True
        BuildUi()
    End Sub

#Region "畫面"
    Private Function Lbl(t As String, Optional bold As Boolean = False) As Label
        Return New Label With {.Text = t, .AutoSize = True, .Anchor = AnchorStyles.Left, .Margin = New Padding(3, 8, 3, 3),
            .Font = If(bold, New Font(Font, FontStyle.Bold), Font)}
    End Function
    Private Function Tb(Optional w As Integer = 200) As TextBox
        Return New TextBox With {.Width = w, .Margin = New Padding(3, 4, 3, 4)}
    End Function
    Private Function Num(min As Integer, max As Integer, v As Integer) As NumericUpDown
        Return New NumericUpDown With {.Minimum = min, .Maximum = max, .Value = v, .Width = 70, .Margin = New Padding(3, 4, 3, 4)}
    End Function
    Private Function Row(ParamArray cs() As Control) As FlowLayoutPanel
        Dim p As New FlowLayoutPanel With {.AutoSize = True, .WrapContents = False, .Margin = New Padding(0)}
        p.Controls.AddRange(cs)
        Return p
    End Function

    Private Sub BuildUi()
        Dim grid As New TableLayoutPanel With {.Dock = DockStyle.Top, .AutoSize = True, .ColumnCount = 2, .Padding = New Padding(14, 12, 14, 0)}
        grid.ColumnStyles.Add(New ColumnStyle(SizeType.Absolute, 110))
        grid.ColumnStyles.Add(New ColumnStyle(SizeType.Percent, 100))

        txtName = Tb(180) : txtBirth = Tb(110)
        cboPhone = New ComboBox With {.Width = 170, .DropDownStyle = ComboBoxStyle.DropDown, .Margin = New Padding(3, 4, 3, 4)}
        chkLine = New CheckBox With {.Text = "LINE", .AutoSize = True}
        chkSms = New CheckBox With {.Text = "簡訊", .AutoSize = True}
        chkTel = New CheckBox With {.Text = "電話", .AutoSize = True}
        chkSelf = New CheckBox With {.Text = "自取", .AutoSize = True}
        lblMemo = New Label With {.AutoSize = True, .ForeColor = Color.FromArgb(30, 90, 170), .MaximumSize = New Size(600, 0), .Margin = New Padding(3, 4, 3, 4)}
        txtHospCode = Tb(115) : txtHospName = Tb(330)
        txtDeptCode = Tb(60) : txtDeptName = Tb(200)
        txtDisp = Tb(90)
        numDays = Num(1, 180, 28) : numCur = Num(1, 3, 1) : numTotal = Num(1, 3, 3) : numLead = Num(0, 30, 10)
        For i = 1 To 3
            txtFill(i) = Tb(100)
        Next
        txtNote = Tb(560)
        txtStaff = Tb(100) : txtStaff.UseSystemPasswordChar = True
        chkPrint = New CheckBox With {.Text = "送出後列印 4×3 寄單貼紙", .AutoSize = True, .Checked = True}

        grid.Controls.Add(Lbl("姓名", True)) : grid.Controls.Add(Row(txtName, Lbl("生日（民國）"), txtBirth, Lbl("例 0750312")))
        grid.Controls.Add(Lbl("電話", True)) : grid.Controls.Add(Row(cboPhone, Lbl("可下拉選另一支或直接修改", False)))
        grid.Controls.Add(Lbl("通知方式", True)) : grid.Controls.Add(Row(chkLine, chkSms, chkTel, chkSelf))
        grid.Controls.Add(Lbl("藥局備註")) : grid.Controls.Add(lblMemo)
        grid.Controls.Add(Lbl("醫院")) : grid.Controls.Add(Row(txtHospCode, txtHospName))
        grid.Controls.Add(Lbl("科別")) : grid.Controls.Add(Row(txtDeptCode, txtDeptName))
        grid.Controls.Add(Lbl("慢箋")) : grid.Controls.Add(Row(Lbl("調劑日"), txtDisp, Lbl("天數"), numDays, Lbl("本次第"), numCur, Lbl("次／共"), numTotal, Lbl("次")))
        grid.Controls.Add(Lbl("領藥日", True)) : grid.Controls.Add(Row(Lbl("第1次"), txtFill(1), Lbl("第2次"), txtFill(2), Lbl("第3次"), txtFill(3)))
        grid.Controls.Add(Lbl("")) : grid.Controls.Add(Row(Lbl("提前"), numLead, Lbl("天（屆滿前可領藥天數）"), New Label With {.Text = "改上面的數字會重算", .AutoSize = True, .ForeColor = Color.Gray, .Margin = New Padding(3, 8, 3, 3)}))
        grid.Controls.Add(Lbl("備註")) : grid.Controls.Add(txtNote)
        grid.Controls.Add(Lbl("人員代碼", True)) : grid.Controls.Add(Row(txtStaff, chkPrint))
        Controls.Add(grid)

        lblWarn = New Label With {.Dock = DockStyle.Bottom, .Height = 66, .ForeColor = Color.FromArgb(180, 60, 0), .Padding = New Padding(16, 4, 16, 0),
            .Font = New Font(Font, FontStyle.Bold)}
        lblStatus = New Label With {.Dock = DockStyle.Bottom, .Height = 26, .ForeColor = Color.Gray, .Padding = New Padding(16, 2, 16, 0)}
        lblStore = New Label With {.AutoSize = True, .ForeColor = Color.FromArgb(0, 117, 111), .Margin = New Padding(14, 12, 3, 3)}
        btnCheck = New Button With {.Text = "重新檢查", .Width = 110, .Height = 38}
        btnOk = New Button With {.Text = "確定寄單 (F2)", .Width = 160, .Height = 38, .BackColor = Color.FromArgb(0, 208, 197), .ForeColor = Color.White,
            .FlatStyle = FlatStyle.Flat, .Font = New Font(Font, FontStyle.Bold)}
        btnCancel = New Button With {.Text = "取消", .Width = 90, .Height = 38, .DialogResult = DialogResult.Cancel}
        Dim bar As New FlowLayoutPanel With {.Dock = DockStyle.Bottom, .Height = 56, .FlowDirection = FlowDirection.RightToLeft, .Padding = New Padding(10, 8, 10, 6)}
        bar.Controls.AddRange(New Control() {btnOk, btnCheck, btnCancel, lblStore})
        Controls.Add(lblWarn) : Controls.Add(lblStatus) : Controls.Add(bar)
        CancelButton = btnCancel

        AddHandler btnCheck.Click, Async Sub() Await CheckAsync()
        AddHandler btnOk.Click, Async Sub() Await SubmitAsync()
        For Each n In New NumericUpDown() {numDays, numCur, numTotal, numLead}
            AddHandler n.ValueChanged, Sub() RecalcFills()
        Next
        AddHandler txtDisp.Leave, Sub() RecalcFills()
        AddHandler KeyDown, Async Sub(s As Object, e As KeyEventArgs)
                                If e.KeyCode = Keys.F2 Then e.Handled = True : Await SubmitAsync()
                            End Sub
        AddHandler Shown, Async Sub() Await CheckAsync()
    End Sub
#End Region

#Region "從處方帶入"
    ''' <summary>
    ''' 由 Form1 呼叫：帶入處方 XML、藥局備註、院所名稱與調劑日（西元 yyyyMMdd）
    ''' </summary>
    Public Sub LoadFromPrescription(xmlContent As String, fileName As String, fileTime As String,
                                    pharmacyMemo As String, hospitalName As String, dispenseDateWestern As String,
                                    Optional pharmacyCustomerNo As String = "")
        clientRef = fileName & "|" & fileTime
        extPatientId = If(pharmacyCustomerNo, "")
        Dim doc As New XmlDocument() : doc.LoadXml(xmlContent)
        Dim person = doc.SelectSingleNode("//person")
        txtName.Text = Attr(person, "name")
        txtBirth.Text = Attr(person, "birth")

        ' 電話：手機優先，市話放在下拉選單
        Dim mobile = Digits(Attr(person, "mobile")), phone = Digits(Attr(person, "phone"))
        cboPhone.Items.Clear()
        For Each p In {mobile, phone}
            If p <> "" AndAlso Not cboPhone.Items.Contains(p) Then cboPhone.Items.Add(p)
        Next
        cboPhone.Text = If(mobile <> "", mobile, phone)

        ' 通知方式：藥局備註含 LINE／簡訊／電話 → 預選
        lblMemo.Text = If(String.IsNullOrWhiteSpace(pharmacyMemo), "（無）", pharmacyMemo)
        Dim memo = If(pharmacyMemo, "")
        chkLine.Checked = memo.IndexOf("LINE", StringComparison.OrdinalIgnoreCase) >= 0
        chkSms.Checked = memo.Contains("簡訊")
        chkTel.Checked = memo.Contains("電話")

        txtHospCode.Text = Attr(doc.SelectSingleNode("case"), "from")
        txtHospName.Text = If(hospitalName, "")
        txtDeptCode.Text = Attr(doc.SelectSingleNode("//study"), "subject")

        txtDisp.Text = ToRoc(dispenseDateWestern)
        Dim days = CInt(Val(Attr(doc.SelectSingleNode("//orders"), "days")))
        If days > 0 Then numDays.Value = Math.Min(numDays.Maximum, days)
        Dim cont = doc.SelectSingleNode("//continous_prescription")
        Dim total = CInt(Val(Attr(cont, "total")))
        If total >= 1 AndAlso total <= 3 Then numTotal.Value = total
        ' ★「本次第幾次」的屬性名稱依各院 XML 而定，依序嘗試；都沒有就預設第 1 次，請藥師確認
        Dim cur = 0
        For Each a In {"count", "times", "seq", "current", "now", "no"}
            cur = CInt(Val(Attr(cont, a)))
            If cur > 0 Then Exit For
        Next
        If cur >= 1 AndAlso cur <= 3 Then numCur.Value = cur
        RecalcFills()
    End Sub

    Private Shared Function Attr(node As XmlNode, name As String) As String
        If node Is Nothing OrElse node.Attributes(name) Is Nothing Then Return ""
        Return node.Attributes(name).Value.Trim()
    End Function
    Private Shared Function Digits(s As String) As String
        Return New String(If(s, "").Where(AddressOf Char.IsDigit).ToArray())
    End Function
    Private Shared Function ToRoc(western As String) As String
        Dim d As Date
        If Date.TryParseExact(If(western, ""), "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, d) Then
            Return (d.Year - 1911).ToString("000") & d.ToString("MMdd")
        End If
        Return ""
    End Function
    Private Shared Function FromRoc(roc As String) As Date?
        Dim t = Digits(roc)
        If t.Length = 6 Then t = "0" & t
        If t.Length <> 7 Then Return Nothing
        Try
            Return New Date(CInt(t.Substring(0, 3)) + 1911, CInt(t.Substring(3, 2)), CInt(t.Substring(5, 2)))
        Catch
            Return Nothing
        End Try
    End Function
    Private Shared Function RocOf(d As Date) As String
        Return (d.Year - 1911).ToString("000") & d.ToString("MMdd")
    End Function

    ' 第 n 次領藥日 = 調劑日 + 天數 ×（n − 本次）− 提前天數；本次（含）以前不寄放
    Private Sub RecalcFills()
        Dim disp = FromRoc(txtDisp.Text)
        Dim cur = CInt(numCur.Value), total = CInt(numTotal.Value)
        For n = 1 To 3
            If n <= cur OrElse n > total Then
                txtFill(n).Text = "" : txtFill(n).Enabled = False
            Else
                txtFill(n).Enabled = True
                If disp.HasValue Then txtFill(n).Text = RocOf(disp.Value.AddDays(CDbl(numDays.Value) * (n - cur) - CDbl(numLead.Value)))
            End If
        Next
    End Sub
#End Region

#Region "送出"
    Private Function BuildPayload() As Dictionary(Of String, Object)
        Dim notify As New List(Of String)
        If chkLine.Checked Then notify.Add("LINE")
        If chkSms.Checked Then notify.Add("簡訊")
        If chkTel.Checked Then notify.Add("電話")
        If chkSelf.Checked Then notify.Add("自取")
        Dim fills As New List(Of Object)
        For n = 1 To 3
            If txtFill(n).Enabled AndAlso txtFill(n).Text.Trim() <> "" Then
                fills.Add(New Dictionary(Of String, Object) From {{"seq", n}, {"due_date", txtFill(n).Text.Trim()}})
            End If
        Next
        Return New Dictionary(Of String, Object) From {
            {"client_ref", clientRef},
            {"staff_code", txtStaff.Text.Trim()},
            {"patient_name", txtName.Text.Trim()},
            {"birth_date", txtBirth.Text.Trim()},
            {"mobile", Digits(cboPhone.Text)},
            {"notify_methods", notify},
            {"hospital_code", txtHospCode.Text.Trim()},
            {"hospital_name", txtHospName.Text.Trim()},
            {"dept_code", txtDeptCode.Text.Trim()},
            {"dept_name", txtDeptName.Text.Trim()},
            {"ext_patient_id", extPatientId},
            {"fills", fills},
            {"note", txtNote.Text.Trim()}
        }
    End Function

    Private Async Function CallIntakeAsync(payload As Dictionary(Of String, Object), dryRun As Boolean) As Task(Of Dictionary(Of String, Object))
        Net.ServicePointManager.SecurityProtocol = Net.ServicePointManager.SecurityProtocol Or Net.SecurityProtocolType.Tls12
        Dim body = Js.Serialize(New Dictionary(Of String, Object) From {{"p_key", ApiKey}, {"p", payload}, {"p_dry_run", dryRun}})
        Using req As New HttpRequestMessage(HttpMethod.Post, ApiUrl)
            req.Headers.Add("apikey", AnonKey)
            req.Headers.Add("Authorization", "Bearer " & AnonKey)
            req.Content = New StringContent(body, Encoding.UTF8, "application/json")
            Using res = Await Http.SendAsync(req)
                Dim txt = Await res.Content.ReadAsStringAsync()
                If Not res.IsSuccessStatusCode Then
                    Throw New ApplicationException($"寄單系統連線失敗（HTTP {CInt(res.StatusCode)}）{vbCrLf}{txt}")
                End If
                Return Js.Deserialize(Of Dictionary(Of String, Object))(txt)
            End Using
        End Using
    End Function

    Private Shared Function S(d As Dictionary(Of String, Object), k As String) As String
        Dim v As Object = Nothing
        Return If(d IsNot Nothing AndAlso d.TryGetValue(k, v) AndAlso v IsNot Nothing, v.ToString(), "")
    End Function
    Private Shared Function Arr(d As Dictionary(Of String, Object), k As String) As IEnumerable(Of Object)
        Dim v As Object = Nothing
        If d IsNot Nothing AndAlso d.TryGetValue(k, v) AndAlso TypeOf v Is System.Collections.IEnumerable AndAlso Not TypeOf v Is String Then
            Return CType(v, System.Collections.IEnumerable).Cast(Of Object)()
        End If
        Return Enumerable.Empty(Of Object)()
    End Function

    Private Sub SetBusy(b As Boolean, msg As String)
        busy = b
        btnOk.Enabled = Not b : btnCheck.Enabled = Not b
        lblStatus.Text = msg
        Cursor = If(b, Cursors.WaitCursor, Cursors.Default)
    End Sub

    ' 試算：伺服器帶出醫院／科別名稱、檢查欄位、列出提醒（不建立寄單）
    Private Async Function CheckAsync() As Task
        If busy Then Return
        SetBusy(True, "檢查中…")
        Try
            Dim r = Await CallIntakeAsync(BuildPayload(), True)
            If S(r, "ok") <> "True" Then
                lblWarn.Text = "⚠ " & S(r, "message")
                SetBusy(False, "請修正後再按「重新檢查」或直接「確定寄單」")
                Return
            End If
            Dim pv = TryCast(r("preview"), Dictionary(Of String, Object))
            If txtHospName.Text.Trim() = "" Then txtHospName.Text = S(pv, "hospital_name")
            If txtDeptName.Text.Trim() = "" OrElse S(pv, "dept_code") <> "" Then txtDeptName.Text = S(pv, "dept_name")
            If Not (chkLine.Checked OrElse chkSms.Checked OrElse chkTel.Checked OrElse chkSelf.Checked) Then
                Dim nm = Arr(pv, "notify_methods").Select(Function(x) x.ToString()).ToList()
                chkLine.Checked = nm.Contains("LINE") : chkSms.Checked = nm.Contains("簡訊")
                chkTel.Checked = nm.Contains("電話") : chkSelf.Checked = nm.Contains("自取")
            End If
            Dim warns = Arr(r, "warnings").Select(Function(x) "⚠ " & x.ToString()).ToList()
            lblWarn.Text = String.Join(vbCrLf, warns)
            lblStore.Text = $"送到：{S(r, "store_name")}"
            SetBusy(False, If(warns.Count = 0, "檢查通過，確認無誤請按「確定寄單」", "有提醒事項，請確認後再寄單"))
        Catch ex As Exception
            lblWarn.Text = "⚠ " & ex.Message
            SetBusy(False, "無法連線寄單系統")
        End Try
    End Function

    Private Async Function SubmitAsync() As Task
        If busy Then Return
        If txtStaff.Text.Trim() = "" Then
            MessageBox.Show("請輸入人員代碼", "建立寄單", MessageBoxButtons.OK, MessageBoxIcon.Warning)
            txtStaff.Focus() : Return
        End If
        SetBusy(True, "寄單中…")
        Try
            Dim r = Await CallIntakeAsync(BuildPayload(), False)
            If S(r, "ok") <> "True" Then
                lblWarn.Text = "⚠ " & S(r, "message")
                SetBusy(False, "寄單失敗，請修正後再送出")
                MessageBox.Show(S(r, "message"), "寄單失敗", MessageBoxButtons.OK, MessageBoxIcon.Warning)
                Return
            End If
            CreatedOrderNo = S(r, "order_no")
            Dim dup = S(r, "duplicate") = "True"

            ' 列印貼紙（RxBridge）
            Dim printMsg = ""
            If chkPrint.Checked Then
                Try
                    Dim lb = Js.Serialize(New Dictionary(Of String, Object) From {{"label", r("label")}, {"copies", 1}})
                    Using pr = Await Http.PostAsync(BridgeUrl.TrimEnd("/"c) & "/print-label", New StringContent(lb, Encoding.UTF8, "application/json"))
                        Dim t = Await pr.Content.ReadAsStringAsync()
                        printMsg = If(pr.IsSuccessStatusCode, vbCrLf & "貼紙已送出列印", vbCrLf & "⚠ 貼紙列印失敗：" & t)
                    End Using
                Catch ex As Exception
                    printMsg = vbCrLf & "⚠ 無法連線 RxBridge，貼紙未列印（可到寄單網頁補印）"
                End Try
            End If

            MessageBox.Show($"{If(dup, "這張處方先前已寄單", "寄單完成")}：{S(r, "order_no_fmt")}  {txtName.Text}{printMsg}",
                            "建立寄單", MessageBoxButtons.OK, MessageBoxIcon.Information)
            DialogResult = DialogResult.OK
            Close()
        Catch ex As Exception
            SetBusy(False, "寄單失敗")
            MessageBox.Show("寄單失敗：" & ex.Message & vbCrLf & vbCrLf & "可直接再按一次「確定寄單」，不會重複建立。",
                            "建立寄單", MessageBoxButtons.OK, MessageBoxIcon.Error)
        End Try
    End Function
#End Region

End Class
