(ns bluegenes.ws.tool-depends-test
  (:require [clojure.test :refer [deftest is testing]]
            [bluegenes.ws.tool-depends :as td]
            [bluegenes-tool-store.tools :as tools]))

(def overrides {"@intermine/a" ["Gene.pathways.name" "Gene.symbol"]
                "@intermine/b" ["AtlasExpression"]})

(defn- tool [npm-name depends]
  {:package {:name npm-name}
   :config (cond-> {:classes ["Gene"]} depends (assoc :depends depends))})

(deftest merge-depends
  (is (= ["X" "Y"] (td/merge-depends nil ["X" "Y"])))
  (is (= ["X" "Y" "Z"] (td/merge-depends ["X" "Y"] ["Y" "Z"])))
  (is (= ["X"] (td/merge-depends ["X"] nil))))

(deftest apply-overrides
  (let [[a b c] (td/apply-overrides overrides
                                    [(tool "@intermine/a" nil)
                                     (tool "@intermine/b" ["AtlasExpression" "RNASeqResult"])
                                     (tool "@intermine/none" nil)])]
    (testing "a tool declaring no depends takes the override"
      (is (= ["Gene.pathways.name" "Gene.symbol"] (get-in a [:config :depends]))))
    (testing "declared and override entries are unioned without duplicates"
      (is (= ["AtlasExpression" "RNASeqResult"] (get-in b [:config :depends]))))
    (testing "a tool without an override is untouched"
      (is (nil? (get-in c [:config :depends])))
      (is (= {:classes ["Gene"]} (:config c))))))

(deftest apply-groups
  (let [groups {"@intermine/a" "Annotation" "@intermine/b" "Export"}
        [a b c] (td/apply-groups groups
                                 [(tool "@intermine/a" nil)
                                  (assoc-in (tool "@intermine/b" nil) [:config :group] "Enrichment")
                                  (tool "@intermine/none" nil)])]
    (is (= "Annotation" (get-in a [:config :group])))
    (testing "a group in the tool's own config wins"
      (is (= "Enrichment" (get-in b [:config :group]))))
    (testing "a tool without an entry gets no group"
      (is (not (contains? (:config c) :group))))))

(defn- own-group? [^java.io.File dir]
  (some? (re-find #"\"group\"" (slurp (java.io.File. dir "config.json")))))

(deftest bundled-groups
  (let [groups (td/load-groups)
        alliance-dirs (filter #(.isDirectory ^java.io.File %)
                              (.listFiles (java.io.File. "alliance-tools")))]
    (is (every? #{"Annotation" "Enrichment" "Export" "Other"} (vals groups)))
    (testing "every Alliance tool has a group here or in its config.json"
      (is (empty? (remove #(or (contains? groups (str "@alliance/" (.getName ^java.io.File %)))
                               (own-group? %))
                          alliance-dirs))))
    (testing "every official tool has a group"
      (is (every? #(contains? groups %) (keys (td/load-overrides)))))
    (testing "every group entry names a tool that is shipped"
      (is (= (set (keys (td/load-overrides)))
             (set (filter #(.startsWith ^String % "@intermine/") (keys groups)))))
      (is (empty? (remove (set (map #(str "@alliance/" (.getName ^java.io.File %)) alliance-dirs))
                          (filter #(.startsWith ^String % "@alliance/") (keys groups))))))))

(deftest bundled-overrides
  (let [m (td/load-overrides)]
    (is (= 18 (count m)))
    (is (every? #(.startsWith ^String % "@intermine/") (keys m)))
    (is (every? #(and (vector? %) (seq %) (every? string? %)) (vals m)))))

(deftest get-all-tools-applies-overrides-and-groups
  (with-redefs [tools/get-all-tools
                (fn [] {:status 200
                        :body {:tools [(tool "@intermine/bluegenes-pathway-visualizer" nil)
                                       (tool "@alliance/bluegenes-alliance-disease-matrix" nil)
                                       (tool "@other/unknown" nil)]}})]
    (let [{:keys [status body]} (td/get-all-tools)
          [pathway matrix unknown] (:tools body)]
      (is (= 200 status))
      (is (= "Annotation" (get-in pathway [:config :group])))
      (is (some #{"Gene.pathways.name"} (get-in pathway [:config :depends])))
      (is (= "Annotation" (get-in matrix [:config :group])))
      (is (nil? (get-in unknown [:config :group]))))))
