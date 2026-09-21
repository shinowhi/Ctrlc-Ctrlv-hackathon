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
    list() { return this.request('/rest/v1/requests?select=*&order=created_at.desc&limit=200'); }
    audit(id) { return this.request('/rest/v1/audit_events?request_id=eq.' + encodeURIComponent(id) + '&select=actor_role,old_status,new_status,reason,created_at,version&order=id.desc&limit=50'); }
    rpc(name,args) { return this.request('/rest/v1/rpc/' + name,{method:'POST',body:JSON.stringify(args)}); }
    upload(path,file) { return this.request('/storage/v1/object/evidence/' + path,{method:'POST',headers:{'Content-Type':file.type,'x-upsert':'false'},body:file}); }
    async signedUrl(path) {
      const result=await this.request('/storage/v1/object/sign/evidence/' + path,{method:'POST',body:JSON.stringify({expiresIn:60})});
      if (typeof result.signedURL !== 'string' || !result.signedURL.startsWith('/object/sign/')) throw new Error('Không tạo được liên kết minh chứng.');
      return this.url + '/storage/v1' + result.signedURL;
    }
  }
  root.FinRefApi=FinRefApi;
  if (typeof module!=='undefined') module.exports=FinRefApi;
})(globalThis);
