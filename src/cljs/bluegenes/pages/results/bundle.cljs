(ns bluegenes.pages.results.bundle
  "Download bundle for a Gene list: asks the BlueGenes backend for a zip of
  TSV files and hands it to the browser as a file download."
  (:require [re-frame.core :refer [reg-event-db reg-event-fx reg-fx reg-sub subscribe dispatch]]
            [clojure.string :as str]
            [oops.core :refer [ocall]]
            [bluegenes.config :refer [server-vars]]))

(defn- state-path
  "State is kept per list, so one list's progress or error does not show on
  another."
  [list-name]
  [:results :bundle list-name])

(def max-genes
  "Matches the cap in the backend namespace bluegenes.ws.bundle."
  5000)

(defn bundle-url []
  (str (:bluegenes-deploy-path @server-vars) "/api/export/bundle"))

(defn file-name
  "Download name from a list name, with characters unsafe in file names
  replaced."
  [list-name]
  (str (str/replace (or list-name "list") #"[^A-Za-z0-9._-]+" "_") "_bundle.zip"))

(defn request-body
  "The backend takes the mine root, so it can check the root against its own
  configured mines, the list name and the token (absent when logged out)."
  [service list-name]
  (cond-> {:root (:root service)
           :listName list-name}
    (:token service) (assoc :token (:token service))))

(defn too-large?
  [size]
  (and (number? size) (> size max-genes)))

(defn supports-bundle?
  "The annotation files need DiseaseAnnotation and PhenotypeAnnotation, which
  only the Alliance model has."
  [model]
  (every? #(contains? (:classes model) %) [:DiseaseAnnotation :PhenotypeAnnotation]))

(defn error-message
  "Backend errors are JSON with an :error key; anything else gets a generic
  message that includes the status."
  [status body]
  (or (when (map? body) (not-empty (:error body)))
      (str "The download failed (status " status ").")))

(defn- save-blob! [blob filename]
  (let [url (ocall js/URL "createObjectURL" blob)
        a (ocall js/document "createElement" "a")]
    (set! (.-href a) url)
    (set! (.-download a) filename)
    (ocall js/document.body "appendChild" a)
    (ocall a "click")
    (ocall js/document.body "removeChild" a)
    (js/setTimeout #(ocall js/URL "revokeObjectURL" url) 10000)))

(defn- parse-json [text]
  (try (js->clj (js/JSON.parse text) :keywordize-keys true)
       (catch :default _ nil)))

(reg-fx
 ::download
 (fn [{:keys [url body filename on-success on-failure]}]
   (-> (js/fetch url #js {:method "POST"
                          :headers #js {"Content-Type" "application/json"}
                          :body (js/JSON.stringify (clj->js body))})
       (.then (fn [res]
                (if (.-ok res)
                  (-> (.blob res)
                      (.then (fn [blob]
                               (save-blob! blob filename)
                               (dispatch on-success))))
                  (-> (.text res)
                      (.then (fn [text]
                               (dispatch (conj on-failure (error-message (.-status res) (parse-json text))))))))))
       (.catch (fn [_]
                 (dispatch (conj on-failure "The BlueGenes server could not be reached.")))))))

(reg-event-fx
 ::download
 (fn [{db :db} [_ list-name]]
   (let [service (get-in db [:mines (:current-mine db) :service])]
     {:db (assoc-in db (state-path list-name) {:downloading? true})
      ::download {:url (bundle-url)
                  :body (request-body service list-name)
                  :filename (file-name list-name)
                  :on-success [::download-success list-name]
                  :on-failure [::download-failure list-name]}})))

(reg-event-db
 ::download-success
 (fn [db [_ list-name]]
   (assoc-in db (state-path list-name) nil)))

(reg-event-db
 ::download-failure
 (fn [db [_ list-name message]]
   (assoc-in db (state-path list-name) {:error message})))

(reg-sub
 ::state
 (fn [db [_ list-name]]
   (get-in db (state-path list-name))))

(defn download-button
  "Renders nothing unless the list is a Gene list and the current mine's
  model has the annotation classes."
  [{:keys [name size type]}]
  (when (and (= "Gene" type) (supports-bundle? @(subscribe [:current-model])))
    (let [{:keys [downloading? error]} @(subscribe [::state name])
          too-large (too-large? size)]
      [:div.download-bundle
       [:button.btn.btn-slim
        {:type "button"
         :disabled (or downloading? too-large)
         :title (if too-large
                  (str "Bundles are limited to " max-genes " genes.")
                  "Genes, orthologs, disease and phenotype annotations as TSV files in a zip")
         :on-click #(dispatch [::download name])}
        (if downloading? "Preparing bundle..." "Download bundle")]
       (when error
         [:p.text-danger.bundle-error error])])))
