(ns bluegenes.ws.tool-depends-test
  (:require [clojure.test :refer [deftest is testing]]
            [bluegenes.ws.tool-depends :as td]))

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

(deftest bundled-overrides
  (let [m (td/load-overrides)]
    (is (= 19 (count m)))
    (is (every? #(.startsWith ^String % "@intermine/") (keys m)))
    (is (every? #(and (vector? %) (seq %) (every? string? %)) (vals m)))))
