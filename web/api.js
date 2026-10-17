/* Supabase REST client: the browser receives only the public key and user tokens. */
(function (root) {
  class FinRefApi {
    constructor(config, storage = sessionStorage) {
      this.url = (config.supabaseUrl || '').replace(/\/$/,'');
      this.key = config.supabaseAnonKey || '';
      this.storage = storage;
      try { this.session = JSON.parse(storage.getItem('finref-session')); } catch { this.session = null; }
    }
    get configured() { return /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(this.url) && !!this.key; }
    remember(session) {
      this.session = session ? {...session, expires_at: session.expires_at || Date.now()/1000 + session.expires_in} : null;
      if (this.session) this.storage.setItem('finref-session', JSON.stringify(this.session));
      else this.storage.removeItem('finref-session');
    }
    async raw(path, options = {}, token) {
      const response = await fetch(this.url + path, {
        ...options, signal: AbortSignal.timeout(60000),
        headers: {apikey: this.key, ...(token ? {Authorization: 'Bearer ' + token} : {}),
          ...(options.body && typeof options.body === 'string' ? {'Content-Type':'application/json'} : {}), ...options.headers}
      });
      const text = await response.text();
      let data; try {data=JSON.parse(text);} catch {data=text;}
      if (!response.ok) {
        const error = new Error(data?.msg || data?.message || data?.error_description || data?.error || 'Không kết nối được dịch vụ.');
        error.status = response.status; throw error;
      }
      return data;
    }
    async refresh() {
      if (!this.refreshing) this.refreshing = (async () => {
        if (!this.session?.refresh_token) throw new Error('Vui lòng đăng nhập lại.');
        try { this.remember(await this.raw('/auth/v1/token?grant_type=refresh_token', {method:'POST', body: JSON.stringify({refresh_token:this.session.refresh_token})})); }
        catch (e) { if (e.status === 400 || e.status === 401) this.remember(null); throw e; }
      })().finally(() => {this.refreshing=null;});
      return this.refreshing;
    }
    async request(path, options) {
      if (!this.session) throw new Error('Vui lòng đăng nhập.');
      if (this.session.expires_at < Date.now()/1000 + 60) await this.refresh();
      try { return await this.raw(path, options, this.session.access_token); }
      catch(e) { if(e.status!==401) throw e; await this.refresh(); return this.raw(path,options,this.session.access_token); }
    }
    async login(email,password) {
      this.remember(await this.raw('/auth/v1/token?grant_type=password', {method:'POST',body:JSON.stringify({email,password})}));
      return this.profile();
    }
    async profile() {
      const user = await this.request('/auth/v1/user');
      const rows = await this.request('/rest/v1/profiles?id=eq.' + encodeURIComponent(user.id) + '&select=id,role,display_name');
      if (!rows.length) throw new Error('Tài khoản chưa được gán vai trò. Hãy chạy bước tạo tài khoản.');
      return rows[0];
    }
    async logout() { try { if(this.session) await this.request('/auth/v1/logout?scope=local',{method:'POST'}); } finally {this.remember(null);} }
    async list(role) {
      const pageSize = 200;
      const scope = role === 'cfo' ? '&or=(and(status.eq.READY_FOR_APPROVAL,amount.gt.20000000),status.eq.CFO_REVIEW,and(status.eq.TREASURER_REVIEW,amount.gt.20000000))' : '';
      const all = [];
      for (let offset = 0; ; offset += pageSize) {
        const page = await this.request(`/rest/v1/requests?select=*&order=created_at.desc,id.desc${scope}&limit=${pageSize}&offset=${offset}`);
        all.push(...page);
        if (page.length < pageSize) return all;
      }
    }
    async getRequest(id) {
      const rows=await this.request('/rest/v1/requests?id=eq.'+encodeURIComponent(id)+'&select=*');
      if(!rows.length) throw new Error('Không có quyền xem hồ sơ này hoặc hồ sơ không còn tồn tại.');
      return rows[0];
    }
    audit(id) { return this.request('/rest/v1/audit_events?request_id=eq.' + encodeURIComponent(id) + '&select=actor_role,old_status,new_status,reason,created_at,version&order=id.desc&limit=50'); }
    rpc(name,args) { return this.request('/rest/v1/rpc/' + name,{method:'POST',body:JSON.stringify(args)}); }
    dailyApprovalSummary() { return this.rpc('daily_approval_summary',{}); }
    vendorDirectory() { return this.rpc('vendor_directory_list',{}); }
    vendorReviewNotes() { return this.rpc('vendor_review_note_list',{}); }
    resolveVendorReviewNote(requestId) { return this.rpc('vendor_review_note_resolve',{p_request_id:requestId}); }
    saveVendor(vendorId,legalName,taxCode,aliases) {
      throw new Error('MVP bảo mật tạm ngừng lưu mới tên, MST và bí danh nhà cung cấp.');
    }
    async privateInvoiceRequest(endpoint, metadata, parts) {
      if (!this.session) throw new Error('Vui lòng đăng nhập.');
      if (this.session.expires_at < Date.now()/1000 + 60) await this.refresh();
      const header=new TextEncoder().encode(JSON.stringify(metadata));
      if(header.byteLength>65536) throw new Error('Thông tin gửi quá lớn.');
      const length=new Uint8Array(4);new DataView(length.buffer).setUint32(0,header.byteLength);
      const response = await fetch('/api/'+endpoint, {
        method:'POST', headers:{'Content-Type':'application/octet-stream', Authorization:'Bearer '+this.session.access_token},
        body:new Blob([length,header,...parts]), signal:AbortSignal.timeout(90000)
      });
      const text = await response.text(); let data; try { data=JSON.parse(text); } catch { data={}; }
      if (!response.ok) { const e=new Error(data.error||'Không đọc được minh chứng.'); e.status=response.status; throw e; }
      return data;
    }
    async signedUrl(path) {
      const result=await this.request('/storage/v1/object/sign/evidence/' + path,{method:'POST',body:JSON.stringify({expiresIn:60})});
      if (typeof result.signedURL !== 'string' || !result.signedURL.startsWith('/object/sign/')) throw new Error('Không tạo được liên kết minh chứng.');
      return this.url + '/storage/v1' + result.signedURL;
    }
  }
  root.FinRefApi=FinRefApi;
  if (typeof module!=='undefined') module.exports=FinRefApi;
})(globalThis);
